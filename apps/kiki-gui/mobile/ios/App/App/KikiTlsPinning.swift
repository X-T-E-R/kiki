import CryptoKit
import Foundation
import Security

enum KikiTlsPinning {
    private static let scopedPrefix = "kiki.shell.tlsFp."
    private static let originMapKey = "kiki.shell.originTlsFp"

    static func normalizeFingerprint(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let clean = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard clean.count == 64 else { return nil }
        for scalar in clean.unicodeScalars {
            let v = scalar.value
            let isHex = (v >= 48 && v <= 57) || (v >= 97 && v <= 102)
            if !isHex { return nil }
        }
        return clean
    }

    static func constantTimeEqual(_ a: String?, _ b: String?) -> Bool {
        guard let a, let b else { return false }
        let left = Array(a.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().utf8)
        let right = Array(b.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().utf8)
        guard !left.isEmpty, left.count == right.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<left.count {
            diff |= left[i] ^ right[i]
        }
        return diff == 0
    }

    static func origin(from space: URLProtectionSpace) -> String {
        let host = space.host.lowercased()
        let shownHost = host.contains(":") ? "[\(host)]" : host
        let port = space.port
        if port <= 0 || port == 443 {
            return "https://\(shownHost)"
        }
        return "https://\(shownHost):\(port)"
    }

    static func certificateSpkiSha256Hex(_ certificate: SecCertificate) -> String? {
        let certData = SecCertificateCopyData(certificate) as Data
        guard let spkiData = extractSpkiDer(fromCertificateDer: certData) else { return nil }
        let digest = SHA256.hash(data: spkiData)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func serverTrustMatchesFingerprint(_ trust: SecTrust, expectedFingerprint: String) -> Bool {
        guard let expected = normalizeFingerprint(expectedFingerprint) else { return false }
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first,
              let actual = certificateSpkiSha256Hex(leaf) else {
            return false
        }
        return constantTimeEqual(actual, expected)
    }

    static func saveFingerprint(_ rawFingerprint: String?, for serverId: String, origin: String) {
        guard !serverId.isEmpty, !origin.isEmpty,
              let fp = normalizeFingerprint(rawFingerprint) else { return }
        let defaults = UserDefaults.standard
        defaults.set(fp, forKey: scopedPrefix + "\(serverId)@\(origin)")
        var map = (defaults.dictionary(forKey: originMapKey) as? [String: String]) ?? [:]
        map[origin] = fp
        defaults.set(map, forKey: originMapKey)
    }

    static func storedFingerprint(forOrigin origin: String, serverId: String? = nil) -> String? {
        guard !origin.isEmpty else { return nil }
        let defaults = UserDefaults.standard
        if let serverId, !serverId.isEmpty,
           let scoped = normalizeFingerprint(defaults.string(forKey: scopedPrefix + "\(serverId)@\(origin)")) {
            return scoped
        }
        if let map = defaults.dictionary(forKey: originMapKey) as? [String: String],
           let mapped = normalizeFingerprint(map[origin]) {
            return mapped
        }
        return nil
    }

    static func removeFingerprints(serverId: String?, origin: String?, verifiedOrigins: [String]) {
        let defaults = UserDefaults.standard
        var map = (defaults.dictionary(forKey: originMapKey) as? [String: String]) ?? [:]
        var originsToClean = Set<String>()
        if let serverId, !serverId.isEmpty {
            for vOrigin in verifiedOrigins {
                defaults.removeObject(forKey: scopedPrefix + "\(serverId)@\(vOrigin)")
                originsToClean.insert(vOrigin)
            }
            if let origin, !origin.isEmpty {
                defaults.removeObject(forKey: scopedPrefix + "\(serverId)@\(origin)")
                originsToClean.insert(origin)
            }
        } else if let origin, !origin.isEmpty {
            originsToClean.insert(origin)
        }
        if !originsToClean.isEmpty {
            for item in originsToClean {
                map.removeValue(forKey: item)
            }
            defaults.set(map, forKey: originMapKey)
        }
    }

    private struct DerTlv {
        let tag: UInt8
        let totalRange: Range<Int>
        let valueRange: Range<Int>
    }

    private static func readDerTlv(_ bytes: [UInt8], offset: Int, limit: Int) -> DerTlv? {
        guard offset < limit else { return nil }
        let tag = bytes[offset]
        var cursor = offset + 1
        guard cursor < limit else { return nil }
        let firstLen = bytes[cursor]
        cursor += 1
        let length: Int
        if (firstLen & 0x80) == 0 {
            length = Int(firstLen)
        } else {
            let count = Int(firstLen & 0x7f)
            guard count > 0, count <= 4, cursor + count <= limit else { return nil }
            var value = 0
            for _ in 0..<count {
                value = (value << 8) | Int(bytes[cursor])
                cursor += 1
            }
            length = value
        }
        let end = cursor + length
        guard end <= limit else { return nil }
        return DerTlv(tag: tag, totalRange: offset..<end, valueRange: cursor..<end)
    }

    static func extractSpkiDer(fromCertificateDer certData: Data) -> Data? {
        let bytes = [UInt8](certData)
        guard let certSeq = readDerTlv(bytes, offset: 0, limit: bytes.count),
              certSeq.tag == 0x30,
              let tbsSeq = readDerTlv(bytes, offset: certSeq.valueRange.lowerBound, limit: certSeq.valueRange.upperBound),
              tbsSeq.tag == 0x30 else {
            return nil
        }
        var cursor = tbsSeq.valueRange.lowerBound
        let tbsEnd = tbsSeq.valueRange.upperBound
        guard let first = readDerTlv(bytes, offset: cursor, limit: tbsEnd) else { return nil }
        if first.tag == 0xa0 {
            cursor = first.totalRange.upperBound
        }
        for _ in 0..<5 {
            guard let elem = readDerTlv(bytes, offset: cursor, limit: tbsEnd) else { return nil }
            cursor = elem.totalRange.upperBound
        }
        guard let spki = readDerTlv(bytes, offset: cursor, limit: tbsEnd),
              spki.tag == 0x30 else {
            return nil
        }
        return Data(bytes[spki.totalRange])
    }
}

final class KikiPinnedSessionDelegate: NSObject, URLSessionTaskDelegate {
    private let lock = NSLock()
    private var taskBindings: [Int: (fingerprint: String?, serverId: String?)] = [:]

    func register(taskId: Int, fingerprint: String?, serverId: String?) {
        lock.lock()
        taskBindings[taskId] = (KikiTlsPinning.normalizeFingerprint(fingerprint), serverId)
        lock.unlock()
    }

    func unregister(taskId: Int) {
        lock.lock()
        taskBindings.removeValue(forKey: taskId)
        lock.unlock()
    }

    private func binding(for taskId: Int) -> (fingerprint: String?, serverId: String?) {
        lock.lock()
        defer { lock.unlock() }
        return taskBindings[taskId] ?? (nil, nil)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        unregister(taskId: task.taskIdentifier)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let origin = KikiTlsPinning.origin(from: challenge.protectionSpace)
        let bound = binding(for: task.taskIdentifier)
        let expected = bound.fingerprint ?? KikiTlsPinning.storedFingerprint(forOrigin: origin, serverId: bound.serverId)
        guard let expected else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        if KikiTlsPinning.serverTrustMatchesFingerprint(trust, expectedFingerprint: expected) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
