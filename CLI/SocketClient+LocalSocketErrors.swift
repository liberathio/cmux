import Foundation
import Darwin

extension SocketClient {
    func actionableLocalSocketConnectFailureMessage(errnoCode: Int32) -> String? {
        guard relayEndpoint == nil else { return nil }

        switch errnoCode {
        case ECONNREFUSED:
            return "cmux app is not listening on socket at \(path). Relaunch cmux or use Restart CLI Listener."
        case ENOENT:
            return "Socket not found at \(path)"
        default:
            return nil
        }
    }

    func actionableLocalSocketWriteFailureMessage(
        errnoCode: Int32,
        failureMessage: String
    ) -> String? {
        guard relayEndpoint == nil, failureMessage == "Failed to write to socket" else {
            return nil
        }

        if let serverMessage = recoverServerMessageAfterEarlyClose(errnoCode: errnoCode) {
            return serverMessage
        }

        switch errnoCode {
        case EPIPE, ECONNRESET:
            return "cmux socket server closed the connection before reading the command. If Socket Control Mode is set to \"cmux processes only\", run this command from a cmux terminal or switch to Automation mode."
        case ENOTCONN:
            return "cmux app is not listening on socket at \(path). Relaunch cmux or use Restart CLI Listener."
        default:
            return nil
        }
    }

    func recoverServerMessageAfterEarlyClose(errnoCode: Int32) -> String? {
        guard errnoCode == EPIPE || errnoCode == ECONNRESET else {
            return nil
        }

        try? configureReceiveTimeout(0.15)

        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)

        while data.count < 16 * 1024 {
            let count = Darwin.read(socketFD, &buffer, buffer.count)
            if count < 0 {
                let readErrno = errno
                if readErrno == EINTR {
                    continue
                }
                if readErrno == EAGAIN || readErrno == EWOULDBLOCK {
                    break
                }
                return nil
            }
            if count == 0 {
                break
            }
            data.append(buffer, count: count)
            if data.contains(UInt8(0x0A)) {
                break
            }
        }

        guard var response = String(data: data, encoding: .utf8) else {
            return nil
        }
        if let newlineIndex = response.firstIndex(of: "\n") {
            response = String(response[..<newlineIndex])
        }
        let trimmed = response.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
