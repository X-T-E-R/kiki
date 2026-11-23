package ai.easyagent.kiki;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.util.Collections;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Loopback bridge for WebSockets to an SPKI-pinned {@code wss://} origin.
 *
 * <p>Android System WebView never consults {@code onReceivedSslError} for WebSocket handshakes, so a
 * self-signed paired server loads over https but its {@code wss://} socket always fails. The page
 * instead connects to {@code ws://127.0.0.1:<port>/__kiki_ws/<secret>/...}; this bridge checks the
 * per-tunnel secret, rewrites the request target and {@code Host}, opens TLS to the real server with
 * the pinned trust manager, verifies the leaf SPKI again and then relays raw bytes both ways.
 */
final class PinnedWsTunnel implements Closeable {
    static final String PATH_PREFIX = "/__kiki_ws/";
    private static final int MAX_HEADER_BYTES = 16 * 1024;
    private static final int PUMP_BUFFER_BYTES = 16 * 1024;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final byte[] HEADER_END = { '\r', '\n', '\r', '\n' };

    private final String connectHost;
    private final int remotePort;
    private final String hostHeader;
    private final String key;
    private final SSLSocketFactory factory;
    private final Predicate<Certificate> peerCheck;
    private final String secret;
    private final ServerSocket server;
    private final Set<Socket> sockets = Collections.newSetFromMap(new ConcurrentHashMap<>());
    private volatile boolean closed;

    private PinnedWsTunnel(
        String remoteHost,
        int remotePort,
        String key,
        SSLSocketFactory factory,
        Predicate<Certificate> peerCheck
    ) throws IOException {
        this.connectHost = stripBrackets(remoteHost);
        this.remotePort = remotePort;
        this.hostHeader = hostHeader(this.connectHost, remotePort);
        this.key = key;
        this.factory = factory;
        this.peerCheck = peerCheck;
        this.secret = randomSecret();
        this.server = new ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
    }

    static PinnedWsTunnel start(
        String remoteHost,
        int remotePort,
        String key,
        SSLSocketFactory factory,
        Predicate<Certificate> peerCheck
    ) throws IOException {
        if (remoteHost == null || remoteHost.isEmpty() || remotePort <= 0 || factory == null || peerCheck == null) {
            throw new IOException("Invalid tunnel target");
        }
        PinnedWsTunnel tunnel = new PinnedWsTunnel(remoteHost, remotePort, key, factory, peerCheck);
        Thread acceptor = new Thread(tunnel::acceptLoop, "kiki-ws-tunnel-accept");
        acceptor.setDaemon(true);
        acceptor.start();
        return tunnel;
    }

    boolean matches(String candidateKey) {
        return !closed && key != null && key.equals(candidateKey);
    }

    /** Base URL the page should use instead of {@code wss://<remote>}; append the original path and query. */
    String localUrl() {
        return "ws://127.0.0.1:" + server.getLocalPort() + PATH_PREFIX + secret;
    }

    @Override
    public void close() {
        closed = true;
        closeQuietly(server);
        for (Socket socket : sockets.toArray(new Socket[0])) {
            release(socket);
        }
    }

    private void acceptLoop() {
        while (!closed) {
            final Socket client;
            try {
                client = server.accept();
            } catch (IOException e) {
                break;
            }
            sockets.add(client);
            Thread worker = new Thread(() -> handle(client), "kiki-ws-tunnel-conn");
            worker.setDaemon(true);
            worker.start();
        }
        close();
    }

    private void handle(Socket client) {
        final Socket raw = new Socket();
        final AtomicReference<Socket> upstreamRef = new AtomicReference<>(raw);
        final CountDownLatch upgraded = new CountDownLatch(1);
        final AtomicBoolean upgradeSucceeded = new AtomicBoolean(false);
        try {
            client.setTcpNoDelay(true);
            byte[] buffered = readHead(client);
            int end = buffered == null ? -1 : indexOf(buffered, HEADER_END);
            if (end < 0) {
                reject(client, "400 Bad Request");
                return;
            }
            int headLength = end + HEADER_END.length;
            String head = new String(buffered, 0, headLength, StandardCharsets.ISO_8859_1);
            String rewritten = rewriteUpgradeRequest(head, secret, hostHeader);
            if (rewritten == null) {
                reject(client, "403 Forbidden");
                return;
            }

            sockets.add(raw);
            if (closed) {
                release(raw);
                release(client);
                return;
            }

            // Watch client closure during TCP/TLS/101 negotiation so an aborted or timed-out
            // WebView socket tears down any stalled upstream immediately without imposing a
            // synthetic combined wall-clock deadline on progressing slow-link handshakes.
            Thread upstreamPump = new Thread(
                () -> watchClientThenPumpUpstream(client, upstreamRef, upgraded, upgradeSucceeded),
                "kiki-ws-tunnel-up"
            );
            upstreamPump.setDaemon(true);
            upstreamPump.start();

            Socket upstream = openPinnedUpstream(raw, upstreamRef);
            if (upstream == null) {
                upgraded.countDown();
                reject(client, "502 Bad Gateway");
                return;
            }
            OutputStream out = upstream.getOutputStream();
            out.write(rewritten.getBytes(StandardCharsets.ISO_8859_1));
            if (buffered.length > headLength) {
                out.write(buffered, headLength, buffered.length - headLength);
            }
            out.flush();

            byte[] response = readHead(upstream);
            if (response == null) {
                upgraded.countDown();
                release(upstream);
                reject(client, "502 Bad Gateway");
                return;
            }
            boolean is101 = startsWith101(response);
            if (is101) {
                upgradeSucceeded.set(true);
            }
            upgraded.countDown();
            OutputStream down = client.getOutputStream();
            down.write(response);
            down.flush();
            if (!is101) {
                release(upstream);
                release(client);
                return;
            }
            pump(upstream, client);
        } catch (IOException e) {
            upgraded.countDown();
            release(client);
            release(raw);
            release(upstreamRef.get());
        }
    }

    private void watchClientThenPumpUpstream(
        Socket client,
        AtomicReference<Socket> upstreamRef,
        CountDownLatch upgraded,
        AtomicBoolean upgradeSucceeded
    ) {
        ByteArrayOutputStream earlyBytes = new ByteArrayOutputStream();
        try {
            InputStream in = client.getInputStream();
            byte[] probe = new byte[PUMP_BUFFER_BYTES];
            while (upgraded.getCount() > 0) {
                int read = in.read(probe);
                if (read == -1) {
                    release(upstreamRef.get());
                    release(client);
                    return;
                }
                earlyBytes.write(probe, 0, read);
                if (upgraded.getCount() == 0) {
                    break;
                }
                if (earlyBytes.size() > MAX_HEADER_BYTES) {
                    release(upstreamRef.get());
                    release(client);
                    return;
                }
            }
            upgraded.await();
            if (!upgradeSucceeded.get()) return;
            Socket upstream = upstreamRef.get();
            OutputStream out = upstream.getOutputStream();
            if (earlyBytes.size() > 0) {
                earlyBytes.writeTo(out);
                earlyBytes.reset();
                out.flush();
            }
            int read;
            while ((read = in.read(probe)) != -1) {
                out.write(probe, 0, read);
                out.flush();
            }
        } catch (IOException | InterruptedException ignored) {
            /* client or upstream closed */
        } finally {
            release(client);
            release(upstreamRef.get());
        }
    }

    private Socket openPinnedUpstream(Socket raw, AtomicReference<Socket> upstreamRef) {
        SSLSocket ssl = null;
        try {
            raw.setTcpNoDelay(true);
            raw.setKeepAlive(true);
            raw.connect(new InetSocketAddress(connectHost, remotePort));
            ssl = (SSLSocket) factory.createSocket(raw, connectHost, remotePort, true);
            sockets.add(ssl);
            upstreamRef.set(ssl);
            if (closed) {
                release(ssl);
                return null;
            }
            ssl.startHandshake();
            Certificate[] peers = ssl.getSession().getPeerCertificates();
            if (peers == null || peers.length == 0 || !peerCheck.test(peers[0])) {
                release(ssl);
                return null;
            }
            sockets.remove(raw);
            return ssl;
        } catch (Exception e) {
            if (ssl != null) release(ssl);
            release(raw);
            return null;
        }
    }

    private void pump(Socket from, Socket to) {
        byte[] buffer = new byte[PUMP_BUFFER_BYTES];
        try {
            InputStream in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                out.flush();
            }
        } catch (IOException ignored) {
            /* either side closed */
        } finally {
            release(from);
            release(to);
        }
    }

    private void release(Socket socket) {
        if (socket == null) return;
        sockets.remove(socket);
        closeQuietly(socket);
    }

    private void reject(Socket client, String status) {
        try {
            OutputStream out = client.getOutputStream();
            out.write(("HTTP/1.1 " + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
        } catch (IOException ignored) {
            /* client already gone */
        } finally {
            release(client);
        }
    }

    /**
     * Reads until the end of the HTTP head; returns everything read so far, or null on EOF/oversize.
     */
    private static byte[] readHead(Socket socket) throws IOException {
        InputStream in = socket.getInputStream();
        ByteArrayOutputStream acc = new ByteArrayOutputStream(1024);
        byte[] chunk = new byte[2048];
        while (acc.size() <= MAX_HEADER_BYTES) {
            int read = in.read(chunk);
            if (read == -1) return null;
            acc.write(chunk, 0, read);
            byte[] sofar = acc.toByteArray();
            if (indexOf(sofar, HEADER_END) >= 0) return sofar;
        }
        return null;
    }

    /**
     * Validates the loopback upgrade request and rewrites it for the real server: the request target
     * must start with {@code /__kiki_ws/<secret>} (stripped), the request must ask for a WebSocket
     * upgrade, and {@code Host} is replaced. Returns null when the request must be refused.
     */
    static String rewriteUpgradeRequest(String head, String secret, String hostHeader) {
        if (head == null || secret == null || secret.isEmpty() || hostHeader == null || !head.endsWith("\r\n\r\n")) {
            return null;
        }
        String[] lines = head.substring(0, head.length() - 4).split("\r\n", -1);
        String[] request = lines[0].split(" ", -1);
        if (request.length != 3 || !"GET".equals(request[0]) || !request[2].startsWith("HTTP/1.")) return null;
        String target = request[1];
        String prefix = PATH_PREFIX + secret;
        if (target.length() < prefix.length() || !secureEquals(target.substring(0, prefix.length()), prefix)) {
            return null;
        }
        String rest = target.substring(prefix.length());
        if (rest.isEmpty()) {
            rest = "/";
        } else if (rest.charAt(0) == '?') {
            rest = "/" + rest;
        } else if (rest.charAt(0) != '/') {
            return null;
        }
        StringBuilder headers = new StringBuilder(head.length());
        boolean upgrade = false;
        for (int i = 1; i < lines.length; i++) {
            String line = lines[i];
            int colon = line.indexOf(':');
            if (colon <= 0) return null;
            String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
            if ("host".equals(name)) continue;
            if ("upgrade".equals(name) && "websocket".equalsIgnoreCase(line.substring(colon + 1).trim())) {
                upgrade = true;
            }
            headers.append(line).append("\r\n");
        }
        if (!upgrade) return null;
        return "GET " + rest + " " + request[2] + "\r\nHost: " + hostHeader + "\r\n" + headers + "\r\n";
    }

    static boolean startsWith101(byte[] response) {
        String status = new String(response, 0, Math.min(response.length, 16), StandardCharsets.ISO_8859_1);
        return status.startsWith("HTTP/1.1 101") || status.startsWith("HTTP/1.0 101");
    }

    static String hostHeader(String host, int port) {
        String bare = stripBrackets(host);
        String rendered = bare.contains(":") ? "[" + bare + "]" : bare;
        return port == 443 ? rendered : rendered + ":" + port;
    }

    private static String stripBrackets(String host) {
        if (host != null && host.length() > 1 && host.startsWith("[") && host.endsWith("]")) {
            return host.substring(1, host.length() - 1);
        }
        return host;
    }

    private static boolean secureEquals(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    private static int indexOf(byte[] haystack, byte[] needle) {
        outer:
        for (int i = 0; i <= haystack.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) continue outer;
            }
            return i;
        }
        return -1;
    }

    private static String randomSecret() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(64);
        for (byte b : bytes) {
            sb.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        }
        return sb.toString();
    }

    private static void closeQuietly(Closeable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (IOException ignored) {
            /* already closed */
        }
    }
}
