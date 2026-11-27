package ai.easyagent.kiki;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.security.cert.Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

final class PeerStreamConnector {
    static final String RELAY_SUBPROTOCOL = "kiki-relay-v1";
    static final long RELAY_STAGGER_MS = 300L;
    private static final int BUFFER_BYTES = 16 * 1024;
    private static final long MAX_WS_QUEUE_BYTES = 4L * 1024L * 1024L;

    private static final OkHttpClient RELAY_WS_CLIENT = new OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .minWebSocketMessageToCompress(Long.MAX_VALUE)
        .followRedirects(false)
        .followSslRedirects(false)
        .addInterceptor(chain ->
            chain.proceed(
                chain.request()
                    .newBuilder()
                    .removeHeader("Sec-WebSocket-Extensions")
                    .build()
            )
        )
        .build();

    private PeerStreamConnector() {}

    static final class ConnectedRoute implements Closeable {
        final Socket socket;
        final boolean viaRelay;
        final String directOrigin;
        final String relayUrl;
        final String hostHeader;

        ConnectedRoute(Socket socket, boolean viaRelay, String directOrigin, String relayUrl, String hostHeader) {
            this.socket = socket;
            this.viaRelay = viaRelay;
            this.directOrigin = directOrigin;
            this.relayUrl = relayUrl;
            this.hostHeader = hostHeader;
        }

        @Override
        public void close() {
            closeQuietly(socket);
        }
    }

    static final class SelectedRoute {
        final boolean viaRelay;
        final String directOrigin;
        final String relayUrl;

        SelectedRoute(boolean viaRelay, String directOrigin, String relayUrl) {
            this.viaRelay = viaRelay;
            this.directOrigin = directOrigin;
            this.relayUrl = relayUrl;
        }
    }

    static final class PinnedPeerSslSocketFactory extends SSLSocketFactory {
        private final SSLSocketFactory delegate;
        private final Predicate<Certificate> peerCheck;

        PinnedPeerSslSocketFactory(SSLSocketFactory delegate, Predicate<Certificate> peerCheck) {
            this.delegate = delegate;
            this.peerCheck = peerCheck;
        }

        @Override
        public String[] getDefaultCipherSuites() {
            return delegate.getDefaultCipherSuites();
        }

        @Override
        public String[] getSupportedCipherSuites() {
            return delegate.getSupportedCipherSuites();
        }

        @Override
        public Socket createSocket(Socket s, String host, int port, boolean autoClose) throws IOException {
            SSLSocket ssl = (SSLSocket) delegate.createSocket(s, "kiki.peer", 443, autoClose);
            verifyHandshake(ssl);
            return ssl;
        }

        @Override
        public Socket createSocket(String host, int port) throws IOException {
            SSLSocket ssl = (SSLSocket) delegate.createSocket(host, port);
            verifyHandshake(ssl);
            return ssl;
        }

        @Override
        public Socket createSocket(String host, int port, InetAddress localHost, int localPort) throws IOException {
            SSLSocket ssl = (SSLSocket) delegate.createSocket(host, port, localHost, localPort);
            verifyHandshake(ssl);
            return ssl;
        }

        @Override
        public Socket createSocket(InetAddress host, int port) throws IOException {
            SSLSocket ssl = (SSLSocket) delegate.createSocket(host, port);
            verifyHandshake(ssl);
            return ssl;
        }

        @Override
        public Socket createSocket(InetAddress address, int port, InetAddress localAddress, int localPort) throws IOException {
            SSLSocket ssl = (SSLSocket) delegate.createSocket(address, port, localAddress, localPort);
            verifyHandshake(ssl);
            return ssl;
        }

        private void verifyHandshake(SSLSocket ssl) throws IOException {
            try {
                ssl.startHandshake();
                Certificate[] peers = ssl.getSession().getPeerCertificates();
                if (peers == null || peers.length == 0 || !peerCheck.test(peers[0])) {
                    closeQuietly(ssl);
                    throw new SSLPeerUnverifiedException("Pinned SPKI verification failed");
                }
            } catch (IOException e) {
                closeQuietly(ssl);
                throw e;
            } catch (Exception e) {
                closeQuietly(ssl);
                throw new IOException("TLS handshake failed", e);
            }
        }
    }

    static final class RelayHttpsLoopbackServer implements Closeable {
        private final String relayUrl;
        private final String pinnedFp;
        private final ServerSocket server;
        private final Set<Closeable> activeHandles = Collections.newSetFromMap(new ConcurrentHashMap<>());
        private volatile boolean closed;

        private RelayHttpsLoopbackServer(String relayUrl, String pinnedFp) throws IOException {
            if (normalizeRelayEndpoint(relayUrl) == null || KikiShellPlugin.normalizeFingerprint(pinnedFp) == null) {
                throw new IOException("Pinned fingerprint and valid relay URL required");
            }
            this.relayUrl = relayUrl;
            this.pinnedFp = KikiShellPlugin.normalizeFingerprint(pinnedFp);
            this.server = new ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
            Thread acceptThread = new Thread(this::acceptLoop, "kiki-relay-https-loopback");
            acceptThread.setDaemon(true);
            acceptThread.start();
        }

        static RelayHttpsLoopbackServer start(String relayUrl, String pinnedFp) throws IOException {
            return new RelayHttpsLoopbackServer(relayUrl, pinnedFp);
        }

        boolean matches(String candidateRelayUrl, String candidateFp) {
            return !closed &&
                relayUrl.equals(candidateRelayUrl) &&
                KikiShellPlugin.constantTimeEquals(pinnedFp, candidateFp);
        }

        String localHttpsOrigin() {
            return "https://127.0.0.1:" + server.getLocalPort();
        }

        private void acceptLoop() {
            while (!closed) {
                final Socket client;
                try {
                    client = server.accept();
                } catch (IOException e) {
                    break;
                }
                activeHandles.add(client);
                Thread worker = new Thread(() -> bridgeClientToRelay(client), "kiki-relay-https-conn");
                worker.setDaemon(true);
                worker.start();
            }
            close();
        }

        private void bridgeClientToRelay(Socket client) {
            try {
                client.setTcpNoDelay(true);
                Closeable wsHandle = attachSocketToRelayWebSocket(client, relayUrl, 5000);
                activeHandles.add(wsHandle);
            } catch (Exception e) {
                activeHandles.remove(client);
                closeQuietly(client);
            }
        }

        @Override
        public void close() {
            closed = true;
            closeQuietly(server);
            for (Closeable handle : activeHandles.toArray(new Closeable[0])) {
                activeHandles.remove(handle);
                closeQuietly(handle);
            }
        }
    }

    static boolean isSyntheticRelayOrigin(String rawOrigin) {
        if (rawOrigin == null || rawOrigin.isEmpty()) return false;
        try {
            URI uri = URI.create(rawOrigin.trim());
            String host = uri.getHost();
            if (host == null) return false;
            String lower = host.toLowerCase(Locale.ROOT);
            return "kiki.peer".equals(lower) || lower.endsWith(".kiki.peer");
        } catch (Exception e) {
            return false;
        }
    }

    static String normalizeRelayEndpoint(String raw) {
        if (raw == null) return null;
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) return null;
        try {
            URI uri = URI.create(trimmed);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!"wss".equals(scheme) && !"ws".equals(scheme)) return null;
            if (uri.getRawUserInfo() != null || uri.getRawFragment() != null) return null;
            String host = uri.getHost();
            if (host == null || host.isEmpty()) return null;
            String path = uri.getRawPath();
            if (path == null || path.isEmpty() || path.contains("//") || path.contains("..")) return null;
            String cleanPath = path.endsWith("/") && path.length() > 1 ? path.substring(0, path.length() - 1) : path;
            boolean validStream = cleanPath.equals("/v1/stream") || cleanPath.endsWith("/v1/stream");
            boolean validConnect = cleanPath.contains("/v1/connect/") && !cleanPath.endsWith("/v1/connect");
            if (!validStream && !validConnect) return null;
            String portPart = uri.getPort() > 0 ? (":" + uri.getPort()) : "";
            String renderedHost = host.contains(":") && !host.startsWith("[") ? ("[" + host + "]") : host.toLowerCase(Locale.ROOT);
            String queryPart = uri.getRawQuery() != null && !uri.getRawQuery().isEmpty() ? ("?" + uri.getRawQuery()) : "";
            return scheme + "://" + renderedHost + portPart + cleanPath + queryPart;
        } catch (Exception e) {
            return null;
        }
    }

    static Socket openRelayLoopbackSocket(String relayUrl, int connectTimeoutMs) throws IOException {
        String normalized = normalizeRelayEndpoint(relayUrl);
        if (normalized == null) {
            throw new IOException("Invalid relay endpoint");
        }
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        ServerSocket pairServer = new ServerSocket(0, 1, loopback);
        Socket clientSide = new Socket();
        AtomicReference<Socket> bridgeSideRef = new AtomicReference<>();
        CountDownLatch acceptedLatch = new CountDownLatch(1);
        Thread acceptThread = new Thread(() -> {
            try {
                Socket accepted = pairServer.accept();
                accepted.setTcpNoDelay(true);
                bridgeSideRef.set(accepted);
            } catch (IOException ignored) {
            } finally {
                closeQuietly(pairServer);
                acceptedLatch.countDown();
            }
        }, "kiki-relay-pair-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();

        try {
            clientSide.setTcpNoDelay(true);
            clientSide.connect(new InetSocketAddress(loopback, pairServer.getLocalPort()), connectTimeoutMs);
            if (!acceptedLatch.await(connectTimeoutMs, TimeUnit.MILLISECONDS) || bridgeSideRef.get() == null) {
                throw new IOException("Loopback pair accept failed");
            }
            Socket bridgeSide = bridgeSideRef.get();
            attachSocketToRelayWebSocket(bridgeSide, normalized, connectTimeoutMs);
            return clientSide;
        } catch (Exception e) {
            closeQuietly(pairServer);
            closeQuietly(clientSide);
            closeQuietly(bridgeSideRef.get());
            if (e instanceof IOException) throw (IOException) e;
            throw new IOException("Relay socket setup failed", e);
        }
    }

    private static Closeable attachSocketToRelayWebSocket(
        final Socket socketSide,
        final String normalizedRelayUrl,
        final int connectTimeoutMs
    ) throws IOException {
        final CountDownLatch openLatch = new CountDownLatch(1);
        final AtomicBoolean opened = new AtomicBoolean(false);
        final AtomicReference<Throwable> errorRef = new AtomicReference<>();
        final AtomicBoolean closed = new AtomicBoolean(false);

        Request request = new Request.Builder()
            .url(normalizedRelayUrl)
            .header("Sec-WebSocket-Protocol", RELAY_SUBPROTOCOL)
            .build();

        final WebSocket ws = RELAY_WS_CLIENT.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                String ext = response.header("Sec-WebSocket-Extensions");
                if (ext != null && !ext.trim().isEmpty()) {
                    errorRef.compareAndSet(null, new IOException("Unexpected WebSocket extension negotiated: " + ext));
                    webSocket.cancel();
                    closeQuietly(socketSide);
                    openLatch.countDown();
                    return;
                }
                opened.set(true);
                openLatch.countDown();
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                if (bytes == null || bytes.size() == 0) return;
                try {
                    OutputStream out = socketSide.getOutputStream();
                    out.write(bytes.toByteArray());
                    out.flush();
                } catch (IOException e) {
                    webSocket.cancel();
                    closeQuietly(socketSide);
                }
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(1000, null);
                try {
                    socketSide.shutdownOutput();
                } catch (IOException ignored) {
                    closeQuietly(socketSide);
                }
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                closed.set(true);
                closeQuietly(socketSide);
                openLatch.countDown();
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                closed.set(true);
                errorRef.compareAndSet(null, t);
                closeQuietly(socketSide);
                openLatch.countDown();
            }
        });

        try {
            boolean signaled = openLatch.await(Math.max(500, connectTimeoutMs), TimeUnit.MILLISECONDS);
            if (!signaled || !opened.get()) {
                ws.cancel();
                closeQuietly(socketSide);
                Throwable cause = errorRef.get();
                throw cause != null
                    ? new IOException("Relay WebSocket connect failed: " + cause.getMessage(), cause)
                    : new IOException("Relay WebSocket connect timed out");
            }
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            ws.cancel();
            closeQuietly(socketSide);
            throw new IOException("Interrupted waiting for relay WebSocket", ie);
        }

        Thread pumpOut = new Thread(() -> {
            byte[] buf = new byte[BUFFER_BYTES];
            try {
                InputStream in = socketSide.getInputStream();
                int read;
                while (!closed.get() && (read = in.read(buf)) != -1) {
                    if (read == 0) continue;
                    while (ws.queueSize() > MAX_WS_QUEUE_BYTES && !closed.get()) {
                        Thread.sleep(5L);
                    }
                    if (!ws.send(ByteString.of(buf, 0, read))) {
                        break;
                    }
                }
                ws.close(1000, null);
            } catch (Exception ignored) {
                ws.cancel();
            } finally {
                closed.set(true);
                closeQuietly(socketSide);
            }
        }, "kiki-relay-ws-pump");
        pumpOut.setDaemon(true);
        pumpOut.start();

        return () -> {
            closed.set(true);
            ws.cancel();
            closeQuietly(socketSide);
        };
    }

    static SSLSocket openRelayPinnedTlsSocket(
        String relayUrl,
        SSLSocketFactory pinnedSslFactory,
        Predicate<Certificate> peerCheck,
        int connectTimeoutMs
    ) throws IOException {
        if (pinnedSslFactory == null || peerCheck == null) {
            throw new IOException("Relay connections require SPKI fingerprint pinning");
        }
        Socket rawLoopback = openRelayLoopbackSocket(relayUrl, connectTimeoutMs);
        SSLSocket ssl = null;
        try {
            ssl = (SSLSocket) pinnedSslFactory.createSocket(rawLoopback, "kiki.peer", 443, true);
            ssl.setSoTimeout(connectTimeoutMs);
            ssl.startHandshake();
            Certificate[] peers = ssl.getSession().getPeerCertificates();
            if (peers == null || peers.length == 0 || !peerCheck.test(peers[0])) {
                closeQuietly(ssl);
                throw new SSLPeerUnverifiedException("Relay peer SPKI fingerprint mismatch");
            }
            ssl.setSoTimeout(0);
            return ssl;
        } catch (Exception e) {
            closeQuietly(ssl);
            closeQuietly(rawLoopback);
            if (e instanceof IOException) throw (IOException) e;
            throw new IOException("Relay TLS handshake failed", e);
        }
    }

    private static ConnectedRoute openDirectEndpoint(
        String rawOrigin,
        SSLSocketFactory pinnedSslFactory,
        Predicate<Certificate> peerCheck,
        int connectTimeoutMs
    ) throws IOException {
        URI uri = URI.create(rawOrigin);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost();
        if (host == null || host.isEmpty()) throw new IOException("Missing host");
        String bareHost = host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
        boolean https = "https".equals(scheme);
        if (!https && !"http".equals(scheme)) throw new IOException("Unsupported scheme");
        int port = uri.getPort() > 0 ? uri.getPort() : (https ? 443 : 80);
        String hostHdr = PinnedWsTunnel.hostHeader(bareHost, port);

        Socket raw = new Socket();
        SSLSocket ssl = null;
        try {
            raw.setTcpNoDelay(true);
            raw.setKeepAlive(true);
            raw.connect(new InetSocketAddress(bareHost, port), connectTimeoutMs);
            if (!https) {
                if (pinnedSslFactory != null) {
                    closeQuietly(raw);
                    throw new IOException("Pinned peer requires HTTPS");
                }
                return new ConnectedRoute(raw, false, rawOrigin, null, hostHdr);
            }
            SSLSocketFactory effectiveFactory = pinnedSslFactory != null
                ? pinnedSslFactory
                : (SSLSocketFactory) SSLSocketFactory.getDefault();
            ssl = (SSLSocket) effectiveFactory.createSocket(raw, bareHost, port, true);
            ssl.setSoTimeout(connectTimeoutMs);
            ssl.startHandshake();
            if (peerCheck != null) {
                Certificate[] peers = ssl.getSession().getPeerCertificates();
                if (peers == null || peers.length == 0 || !peerCheck.test(peers[0])) {
                    closeQuietly(ssl);
                    throw new SSLPeerUnverifiedException("Direct peer SPKI mismatch");
                }
            }
            ssl.setSoTimeout(0);
            return new ConnectedRoute(ssl, false, rawOrigin, null, hostHdr);
        } catch (Exception e) {
            closeQuietly(ssl);
            closeQuietly(raw);
            if (e instanceof IOException) throw (IOException) e;
            throw new IOException("Direct connect failed", e);
        }
    }

    static ConnectedRoute raceConnect(
        List<String> rawDirectEndpoints,
        List<String> rawRelayEndpoints,
        SSLSocketFactory pinnedSslFactory,
        Predicate<Certificate> peerCheck,
        int connectTimeoutMs
    ) throws IOException {
        List<String> directList = new ArrayList<>();
        if (rawDirectEndpoints != null) {
            for (String ep : rawDirectEndpoints) {
                if (ep != null && !ep.isEmpty() && !isSyntheticRelayOrigin(ep) && !directList.contains(ep)) {
                    directList.add(ep);
                }
            }
        }
        List<String> relayList = new ArrayList<>();
        if (rawRelayEndpoints != null && pinnedSslFactory != null && peerCheck != null) {
            for (String relay : rawRelayEndpoints) {
                String norm = normalizeRelayEndpoint(relay);
                if (norm != null && !relayList.contains(norm)) {
                    relayList.add(norm);
                }
            }
        }
        int total = directList.size() + relayList.size();
        if (total == 0) {
            throw new IOException("No valid peer endpoints to connect");
        }

        final AtomicReference<ConnectedRoute> winner = new AtomicReference<>();
        final AtomicReference<SSLPeerUnverifiedException> tlsPinError = new AtomicReference<>();
        final AtomicReference<IOException> firstError = new AtomicReference<>();
        final AtomicInteger remaining = new AtomicInteger(total);
        final CountDownLatch doneLatch = new CountDownLatch(1);
        final AtomicBoolean cancelled = new AtomicBoolean(false);

        for (final String directOrigin : directList) {
            Thread t = new Thread(() -> {
                try {
                    ConnectedRoute route = openDirectEndpoint(directOrigin, pinnedSslFactory, peerCheck, connectTimeoutMs);
                    if (winner.compareAndSet(null, route)) {
                        cancelled.set(true);
                        doneLatch.countDown();
                    } else {
                        route.close();
                    }
                } catch (SSLPeerUnverifiedException pinEx) {
                    tlsPinError.compareAndSet(null, pinEx);
                } catch (IOException e) {
                    firstError.compareAndSet(null, e);
                } finally {
                    if (remaining.decrementAndGet() == 0) {
                        doneLatch.countDown();
                    }
                }
            }, "kiki-race-direct");
            t.setDaemon(true);
            t.start();
        }

        final boolean hasDirect = !directList.isEmpty();
        for (int i = 0; i < relayList.size(); i++) {
            final String relayUrl = relayList.get(i);
            final long staggerMs = (hasDirect ? (i + 1) : i) * RELAY_STAGGER_MS;
            Thread t = new Thread(() -> {
                try {
                    if (staggerMs > 0) {
                        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(staggerMs);
                        while (!cancelled.get()) {
                            long remNs = deadline - System.nanoTime();
                            if (remNs <= 0L) break;
                            if (hasDirect && remaining.get() <= relayList.size()) break;
                            Thread.sleep(Math.min(25L, TimeUnit.NANOSECONDS.toMillis(remNs) + 1L));
                        }
                    }
                    if (cancelled.get() || winner.get() != null) return;
                    SSLSocket ssl = openRelayPinnedTlsSocket(relayUrl, pinnedSslFactory, peerCheck, connectTimeoutMs);
                    ConnectedRoute route = new ConnectedRoute(ssl, true, null, relayUrl, "kiki.peer");
                    if (winner.compareAndSet(null, route)) {
                        cancelled.set(true);
                        doneLatch.countDown();
                    } else {
                        route.close();
                    }
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                } catch (SSLPeerUnverifiedException pinEx) {
                    tlsPinError.compareAndSet(null, pinEx);
                } catch (IOException e) {
                    firstError.compareAndSet(null, e);
                } finally {
                    if (remaining.decrementAndGet() == 0) {
                        doneLatch.countDown();
                    }
                }
            }, "kiki-race-relay-" + i);
            t.setDaemon(true);
            t.start();
        }

        long maxWaitMs = connectTimeoutMs + (relayList.size() * RELAY_STAGGER_MS) + 1000L;
        try {
            doneLatch.await(maxWaitMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            cancelled.set(true);
            ConnectedRoute late = winner.getAndSet(null);
            if (late != null) late.close();
            throw new IOException("Interrupted waiting for peer connection", ie);
        }

        cancelled.set(true);
        ConnectedRoute won = winner.get();
        if (won != null) return won;
        if (tlsPinError.get() != null) throw tlsPinError.get();
        IOException err = firstError.get();
        throw err != null ? err : new IOException("All direct and relay endpoints unreachable");
    }

    static SelectedRoute selectRoute(
        List<String> directEndpoints,
        List<String> relayEndpoints,
        String rawPinnedFp,
        int connectTimeoutMs
    ) throws IOException {
        String cleanFp = KikiShellPlugin.normalizeFingerprint(rawPinnedFp);
        SSLSocketFactory pinnedFactory = null;
        Predicate<Certificate> peerCheck = null;
        if (cleanFp != null) {
            try {
                pinnedFactory = KikiShellPlugin.pinnedSslContext(cleanFp).getSocketFactory();
                final String expected = cleanFp;
                peerCheck = cert -> KikiShellPlugin.constantTimeEquals(KikiShellPlugin.certificateSpkiSha256Hex(cert), expected);
            } catch (Exception e) {
                throw new IOException("Failed to initialize pinned SSL context", e);
            }
        }
        try (ConnectedRoute route = raceConnect(directEndpoints, relayEndpoints, pinnedFactory, peerCheck, connectTimeoutMs)) {
            return new SelectedRoute(route.viaRelay, route.directOrigin, route.relayUrl);
        }
    }

    private static void closeQuietly(Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (Exception ignored) {
        }
    }
}
