import XCTest
import AppKit
import Darwin

#if canImport(cmux_DEV)
@testable import cmux_DEV
#elseif canImport(cmux)
@testable import cmux
#endif

@MainActor
final class TerminalControllerSocketListenerRecoveryTests: XCTestCase {
    private func makeSocketPath(_ name: String) -> String {
        let shortID = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8)
        return URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("crec-\(name.prefix(4))-\(shortID).sock")
            .path
    }

    override func setUp() {
        super.setUp()
        TerminalController.shared.stop()
    }

    override func tearDown() {
        TerminalController.shared.stop()
        super.tearDown()
    }

    func testStartRebindsStaleSocketPathAndServesPing() throws {
        let socketPath = makeSocketPath("stale-socket")
        let tabManager = TabManager()

        try createStaleSocket(at: socketPath)
        XCTAssertTrue(FileManager.default.fileExists(atPath: socketPath))

        TerminalController.shared.start(
            tabManager: tabManager,
            socketPath: socketPath,
            accessMode: .allowAll
        )

        let pingResponse = try waitForPingResponse(at: socketPath)
        XCTAssertEqual(pingResponse, "PONG")
    }

    private func waitForPingResponse(at path: String, timeout: TimeInterval = 5.0) throws -> String {
        let deadline = Date().addingTimeInterval(timeout)
        var lastError: Error?

        while Date() < deadline {
            do {
                return try sendPing(to: path)
            } catch {
                lastError = error
                RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            }
        }

        XCTFail("Timed out waiting for ping response at \(path): \(String(describing: lastError))")
        throw lastError ?? NSError(domain: NSPOSIXErrorDomain, code: Int(ETIMEDOUT))
    }

    private nonisolated func createStaleSocket(at socketPath: String) throws {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw posixError("socket(AF_UNIX)")
        }
        defer { Darwin.close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)

        let bytes = Array(socketPath.utf8)
        let maxPathLen = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < maxPathLen else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENAMETOOLONG))
        }

        withUnsafeMutablePointer(to: &addr.sun_path) { pathPtr in
            let cPath = UnsafeMutableRawPointer(pathPtr).assumingMemoryBound(to: CChar.self)
            cPath.initialize(repeating: 0, count: maxPathLen)
            for (index, byte) in bytes.enumerated() {
                cPath[index] = CChar(bitPattern: byte)
            }
        }

        let addrLen = socklen_t(MemoryLayout<sa_family_t>.size + bytes.count + 1)
        let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                Darwin.bind(fd, sockaddrPtr, addrLen)
            }
        }
        guard bindResult == 0 else {
            throw posixError("bind(\(socketPath))")
        }
    }

    private nonisolated func sendPing(to socketPath: String) throws -> String {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw posixError("socket(AF_UNIX)")
        }
        defer { Darwin.close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)

        let bytes = Array(socketPath.utf8)
        let maxPathLen = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < maxPathLen else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENAMETOOLONG))
        }

        withUnsafeMutablePointer(to: &addr.sun_path) { pathPtr in
            let cPath = UnsafeMutableRawPointer(pathPtr).assumingMemoryBound(to: CChar.self)
            cPath.initialize(repeating: 0, count: maxPathLen)
            for (index, byte) in bytes.enumerated() {
                cPath[index] = CChar(bitPattern: byte)
            }
        }

        let addrLen = socklen_t(MemoryLayout<sa_family_t>.size + bytes.count + 1)
        let connectResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                Darwin.connect(fd, sockaddrPtr, addrLen)
            }
        }
        guard connectResult == 0 else {
            throw posixError("connect(\(socketPath))")
        }

        let payload = Array("ping\n".utf8)
        let wrote = payload.withUnsafeBytes { raw in
            Darwin.write(fd, raw.baseAddress!, payload.count)
        }
        guard wrote == payload.count else {
            throw posixError("write(ping)")
        }

        var buffer = [UInt8](repeating: 0, count: 1)
        var data = Data()
        while true {
            let count = Darwin.read(fd, &buffer, 1)
            guard count >= 0 else {
                throw posixError("read")
            }
            if count == 0 || buffer[0] == 0x0A {
                break
            }
            data.append(buffer[0])
        }

        guard let line = String(data: data, encoding: .utf8) else {
            throw NSError(
                domain: NSCocoaErrorDomain,
                code: NSFileReadUnknownError,
                userInfo: [NSLocalizedDescriptionKey: "Invalid UTF-8 response from socket"]
            )
        }
        return line
    }

    private nonisolated func posixError(_ operation: String) -> NSError {
        NSError(
            domain: NSPOSIXErrorDomain,
            code: Int(errno),
            userInfo: [NSLocalizedDescriptionKey: "\(operation) failed: \(String(cString: strerror(errno)))"]
        )
    }
}
