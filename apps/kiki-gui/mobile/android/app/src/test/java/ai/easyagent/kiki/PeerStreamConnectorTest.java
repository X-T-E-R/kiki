package ai.easyagent.kiki;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import org.junit.Test;

public class PeerStreamConnectorTest {

    @Test
    public void normalizeRelayEndpoint_acceptsStreamAndConnectPaths_andRejectsInvalid() {
        String validStream = PeerStreamConnector.normalizeRelayEndpoint(
            "wss://Relay.Example.com:8443/prefix/v1/stream?target=" + "ab".repeat(32) + "&rt=p.123"
        );
        assertEquals(
            "wss://relay.example.com:8443/prefix/v1/stream?target=" + "ab".repeat(32) + "&rt=p.123",
            validStream
        );
        String validConnect = PeerStreamConnector.normalizeRelayEndpoint(
            "ws://127.0.0.1:19876/v1/connect/node_01"
        );
        assertEquals("ws://127.0.0.1:19876/v1/connect/node_01", validConnect);
        assertNull(PeerStreamConnector.normalizeRelayEndpoint("https://relay.example.com/v1/stream"));
        assertNull(PeerStreamConnector.normalizeRelayEndpoint("wss://relay.example.com/other/path"));
        assertNull(PeerStreamConnector.normalizeRelayEndpoint("wss://user@relay.example.com/v1/stream"));
    }

    @Test
    public void happyEyeballs_relayTunnel_sendsSubprotocolWithoutDeflate_andVerifiesSpkiFp() throws Exception {
        try (TlsServer tls = TlsServer.start(); RelayWsServer relay = RelayWsServer.start(tls.port())) {
            String relayUrl = "ws://127.0.0.1:" + relay.port() + "/v1/stream?target=" + tls.fpHex + "&rt=g.ticket";
            SSLSocketFactory trustAll = trustAllFactory();

            try {
                PeerStreamConnector.raceConnect(
                    Collections.emptyList(),
                    Collections.singletonList(relayUrl),
                    trustAll,
                    cert -> matchesFp(cert, "00".repeat(32)),
                    3000
                );
                fail("Expected SSLPeerUnverifiedException on mismatched SPKI fp");
            } catch (SSLPeerUnverifiedException expected) {
                // expected
            }

            try (PeerStreamConnector.ConnectedRoute route = PeerStreamConnector.raceConnect(
                Collections.emptyList(),
                Collections.singletonList(relayUrl),
                trustAll,
                cert -> matchesFp(cert, tls.fpHex),
                3000
            )) {
                assertTrue(route.viaRelay);
                String req = "GET /api/health HTTP/1.1\r\nHost: kiki.peer\r\nConnection: close\r\n\r\n";
                route.socket.getOutputStream().write(req.getBytes(StandardCharsets.ISO_8859_1));
                route.socket.getOutputStream().flush();
                String resp = new String(readAll(route.socket.getInputStream()), StandardCharsets.UTF_8);
                assertTrue(resp.contains("HTTP/1.1 200 OK"));
                assertTrue(resp.contains("\"status\":\"ok\""));
            }

            assertTrue(!relay.observedHeaders.isEmpty());
            for (Map<String, String> h : relay.observedHeaders) {
                assertEquals("kiki-relay-v1", h.get("sec-websocket-protocol"));
                assertNull(h.get("sec-websocket-extensions"));
            }
        }
    }

    private static boolean matchesFp(Certificate cert, String expectedHex) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(cert.getPublicKey().getEncoded());
            StringBuilder sb = new StringBuilder(64);
            for (byte b : digest) sb.append(String.format("%02x", b));
            return sb.toString().equalsIgnoreCase(expectedHex);
        } catch (Exception e) {
            return false;
        }
    }

    private static SSLSocketFactory trustAllFactory() throws Exception {
        TrustManager tm = new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) {}
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) {}
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[] { tm }, new SecureRandom());
        return ctx.getSocketFactory();
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) >= 0) {
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    private static String readHeaders(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int state = 0;
        while (out.size() < 8192) {
            int b = in.read();
            if (b < 0) break;
            out.write(b);
            if (state == 0 && b == '\r') state = 1;
            else if (state == 1 && b == '\n') state = 2;
            else if (state == 2 && b == '\r') state = 3;
            else if (state == 3 && b == '\n') break;
            else if (b == '\r') state = 1;
            else state = 0;
        }
        return out.toString(StandardCharsets.ISO_8859_1.name());
    }

    private static final class TlsServer implements Closeable {
        private final ServerSocket server;
        final String fpHex;

        private TlsServer(ServerSocket server, String fpHex) {
            this.server = server;
            this.fpHex = fpHex;
            Thread t = new Thread(() -> {
                while (!server.isClosed()) {
                    try {
                        SSLSocket sock = (SSLSocket) server.accept();
                        Thread worker = new Thread(() -> {
                            try (SSLSocket s = sock) {
                                s.setSoTimeout(3000);
                                s.startHandshake();
                                readHeaders(new BufferedInputStream(s.getInputStream()));
                                byte[] body = "{\"status\":\"ok\"}".getBytes(StandardCharsets.UTF_8);
                                String head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n";
                                s.getOutputStream().write(head.getBytes(StandardCharsets.ISO_8859_1));
                                s.getOutputStream().write(body);
                                s.getOutputStream().flush();
                            } catch (IOException ignored) {
                            }
                        });
                        worker.setDaemon(true);
                        worker.start();
                    } catch (IOException e) {
                        return;
                    }
                }
            });
            t.setDaemon(true);
            t.start();
        }

        int port() { return server.getLocalPort(); }

        @Override public void close() throws IOException { server.close(); }

        static TlsServer start() throws Exception {
            File dir = Files.createTempDirectory("kiki-java-tls-").toFile();
            File ksFile = new File(dir, "peer.p12");
            String pass = "testpass";
            try {
                boolean win = System.getProperty("os.name").toLowerCase().contains("win");
                File kt = new File(System.getProperty("java.home"), win ? "bin/keytool.exe" : "bin/keytool");
                Process p = new ProcessBuilder(
                    kt.getAbsolutePath(), "-genkeypair", "-alias", "peer",
                    "-keyalg", "EC", "-groupname", "secp256r1", "-sigalg", "SHA256withECDSA",
                    "-dname", "CN=kiki.peer", "-validity", "2", "-storetype", "PKCS12",
                    "-keystore", ksFile.getAbsolutePath(), "-storepass", pass, "-keypass", pass
                ).redirectErrorStream(true).start();
                readAll(p.getInputStream());
                if (p.waitFor() != 0) throw new IOException("keytool failed");
                KeyStore ks = KeyStore.getInstance("PKCS12");
                try (FileInputStream in = new FileInputStream(ksFile)) { ks.load(in, pass.toCharArray()); }
                X509Certificate cert = (X509Certificate) ks.getCertificate("peer");
                byte[] spkiSha = MessageDigest.getInstance("SHA-256").digest(cert.getPublicKey().getEncoded());
                StringBuilder fp = new StringBuilder(64);
                for (byte b : spkiSha) fp.append(String.format("%02x", b));
                KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
                kmf.init(ks, pass.toCharArray());
                SSLContext ctx = SSLContext.getInstance("TLS");
                ctx.init(kmf.getKeyManagers(), null, new SecureRandom());
                ServerSocket ss = ctx.getServerSocketFactory().createServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
                return new TlsServer(ss, fp.toString());
            } finally {
                ksFile.delete();
                dir.delete();
            }
        }
    }

    private static final class RelayWsServer implements Closeable {
        private final ServerSocket server;
        final List<Map<String, String>> observedHeaders = new CopyOnWriteArrayList<>();

        private RelayWsServer(ServerSocket server, int targetPort) {
            this.server = server;
            Thread t = new Thread(() -> {
                while (!server.isClosed()) {
                    try {
                        Socket client = server.accept();
                        Thread worker = new Thread(() -> bridge(client, targetPort));
                        worker.setDaemon(true);
                        worker.start();
                    } catch (IOException e) {
                        return;
                    }
                }
            });
            t.setDaemon(true);
            t.start();
        }

        int port() { return server.getLocalPort(); }

        @Override public void close() throws IOException { server.close(); }

        static RelayWsServer start(int targetPort) throws IOException {
            return new RelayWsServer(new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1")), targetPort);
        }

        private void bridge(Socket wsSock, int targetPort) {
            try (Socket s = wsSock) {
                s.setTcpNoDelay(true);
                BufferedInputStream wsIn = new BufferedInputStream(s.getInputStream());
                OutputStream wsOut = s.getOutputStream();
                String raw = readHeaders(wsIn);
                Map<String, String> headers = new LinkedHashMap<>();
                String[] lines = raw.split("\r\n");
                for (int i = 1; i < lines.length; i++) {
                    int idx = lines[i].indexOf(':');
                    if (idx > 0) headers.put(lines[i].substring(0, idx).trim().toLowerCase(), lines[i].substring(idx + 1).trim());
                }
                observedHeaders.add(Collections.unmodifiableMap(headers));
                String key = headers.get("sec-websocket-key");
                if (key == null) return;
                String accept = Base64.getEncoder().encodeToString(
                    MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.ISO_8859_1))
                );
                String resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\nSec-WebSocket-Protocol: kiki-relay-v1\r\n\r\n";
                wsOut.write(resp.getBytes(StandardCharsets.ISO_8859_1));
                wsOut.flush();

                try (Socket up = new Socket("127.0.0.1", targetPort)) {
                    up.setTcpNoDelay(true);
                    Thread down = new Thread(() -> {
                        byte[] buf = new byte[8192];
                        try {
                            int n;
                            while ((n = up.getInputStream().read(buf)) >= 0) {
                                if (n > 0) writeFrame(wsOut, 0x2, buf, n);
                            }
                            writeFrame(wsOut, 0x8, new byte[0], 0);
                        } catch (IOException ignored) {
                        }
                    });
                    down.setDaemon(true);
                    down.start();

                    DataInputStream din = new DataInputStream(wsIn);
                    while (true) {
                        int b0 = din.read();
                        if (b0 < 0) break;
                        int opcode = b0 & 0x0F;
                        int b1 = din.readUnsignedByte();
                        boolean masked = (b1 & 0x80) != 0;
                        int len = b1 & 0x7F;
                        if (len == 126) len = din.readUnsignedShort();
                        else if (len == 127) len = (int) din.readLong();
                        byte[] mask = new byte[4];
                        if (masked) din.readFully(mask);
                        byte[] payload = new byte[len];
                        din.readFully(payload);
                        if (masked) {
                            for (int i = 0; i < len; i++) payload[i] ^= mask[i % 4];
                        }
                        if (opcode == 0x2 || opcode == 0x0) {
                            up.getOutputStream().write(payload);
                            up.getOutputStream().flush();
                        } else if (opcode == 0x8) {
                            break;
                        } else if (opcode == 0x9) {
                            writeFrame(wsOut, 0xA, payload, payload.length);
                        }
                    }
                    down.join(2000);
                }
            } catch (Exception ignored) {
            }
        }

        private static synchronized void writeFrame(OutputStream out, int opcode, byte[] data, int len) throws IOException {
            out.write(0x80 | (opcode & 0x0F));
            if (len <= 125) {
                out.write(len);
            } else {
                out.write(126);
                out.write((len >>> 8) & 0xFF);
                out.write(len & 0xFF);
            }
            if (len > 0) out.write(data, 0, len);
            out.flush();
        }
    }
}
