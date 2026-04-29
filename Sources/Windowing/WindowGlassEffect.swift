import AppKit
import ObjectiveC
import SwiftUI

/// Applies NSGlassEffectView (macOS 26+) to a window, falling back to NSVisualEffectView
enum WindowGlassEffect {
    enum Style: Equatable {
        case regular
        case clear

        fileprivate var rawNSGlassEffectViewStyle: Int {
            switch self {
            case .regular: return 0
            case .clear: return 1
            }
        }
    }

    private static var glassViewKey: UInt8 = 0
    private static var originalContentViewKey: UInt8 = 0
    private static var tintOverlayKey: UInt8 = 0

    static var isAvailable: Bool {
        NSClassFromString("NSGlassEffectView") != nil
    }

    static func apply(to window: NSWindow, tintColor: NSColor? = nil, style: Style? = nil) {
        guard let originalContentView = window.contentView else { return }

        // Check if we already applied glass (avoid re-wrapping)
        if let existingGlass = objc_getAssociatedObject(window, &glassViewKey) as? NSView {
            // Already applied, just update the tint/style.
            updateConfiguration(on: existingGlass, color: tintColor, style: style, window: window)
            return
        }

        let bounds = originalContentView.bounds

        // Create the glass/blur view
        let glassView: NSView
        let usingGlassEffectView: Bool

        // Try NSGlassEffectView first (macOS 26 Tahoe+)
        if let glassClass = NSClassFromString("NSGlassEffectView") as? NSView.Type {
            usingGlassEffectView = true
            glassView = glassClass.init(frame: bounds)
            glassView.wantsLayer = true
            glassView.layer?.cornerRadius = 0

            updateNativeGlassConfiguration(on: glassView, color: tintColor, style: style)
        } else {
            usingGlassEffectView = false
            // Fallback to NSVisualEffectView
            let fallbackView = NSVisualEffectView(frame: bounds)
            fallbackView.blendingMode = .behindWindow
            // Favor a lighter fallback so behind-window glass reads more transparent.
            fallbackView.material = .underWindowBackground
            fallbackView.state = .active
            fallbackView.wantsLayer = true
            glassView = fallbackView
        }

        glassView.autoresizingMask = [.width, .height]

        if usingGlassEffectView {
            // NSGlassEffectView is a full replacement for the contentView.
            objc_setAssociatedObject(window, &originalContentViewKey, originalContentView, .OBJC_ASSOCIATION_RETAIN)
            window.contentView = glassView

            // Re-add the original SwiftUI hosting view on top of the glass, filling entire area.
            originalContentView.translatesAutoresizingMaskIntoConstraints = false
            originalContentView.wantsLayer = true
            originalContentView.layer?.backgroundColor = NSColor.clear.cgColor
            glassView.addSubview(originalContentView)

            NSLayoutConstraint.activate([
                originalContentView.topAnchor.constraint(equalTo: glassView.topAnchor),
                originalContentView.bottomAnchor.constraint(equalTo: glassView.bottomAnchor),
                originalContentView.leadingAnchor.constraint(equalTo: glassView.leadingAnchor),
                originalContentView.trailingAnchor.constraint(equalTo: glassView.trailingAnchor)
            ])
        } else {
            // For NSVisualEffectView fallback (macOS 13-15), do NOT replace window.contentView.
            // Replacing contentView can break traffic light rendering with
            // `.fullSizeContentView` + `titlebarAppearsTransparent`.
            glassView.translatesAutoresizingMaskIntoConstraints = false
            originalContentView.addSubview(glassView, positioned: .below, relativeTo: nil)

            NSLayoutConstraint.activate([
                glassView.topAnchor.constraint(equalTo: originalContentView.topAnchor),
                glassView.bottomAnchor.constraint(equalTo: originalContentView.bottomAnchor),
                glassView.leadingAnchor.constraint(equalTo: originalContentView.leadingAnchor),
                glassView.trailingAnchor.constraint(equalTo: originalContentView.trailingAnchor)
            ])
        }

        // Add tint overlay between glass and content (for fallback)
        if let tintColor, !usingGlassEffectView {
            let tintOverlay = ensureTintOverlay(on: glassView, window: window)
            tintOverlay.layer?.backgroundColor = tintColor.cgColor
        }

        // Store reference
        objc_setAssociatedObject(window, &glassViewKey, glassView, .OBJC_ASSOCIATION_RETAIN)
    }

    /// Update the tint color on an existing glass effect
    static func updateTint(to window: NSWindow, color: NSColor?) {
        guard let glassView = objc_getAssociatedObject(window, &glassViewKey) as? NSView else { return }
        updateConfiguration(on: glassView, color: color, style: nil, window: window)
    }

    private static func updateConfiguration(on glassView: NSView, color: NSColor?, style: Style?, window: NSWindow) {
        if glassView.className == "NSGlassEffectView" {
            updateNativeGlassConfiguration(on: glassView, color: color, style: style)
        } else {
            // For NSVisualEffectView fallback, update the tint overlay
            if let color {
                let tintOverlay = ensureTintOverlay(on: glassView, window: window)
                tintOverlay.layer?.backgroundColor = color.cgColor
            } else if let tintOverlay = objc_getAssociatedObject(window, &tintOverlayKey) as? NSView {
                tintOverlay.layer?.backgroundColor = color?.cgColor
            }
        }
    }

    private static func updateNativeGlassConfiguration(on glassView: NSView, color: NSColor?, style: Style?) {
        let tintSelector = NSSelectorFromString("setTintColor:")
        if glassView.responds(to: tintSelector) {
            glassView.perform(tintSelector, with: color)
        }

        guard let style else { return }
        let styleSelector = NSSelectorFromString("setStyle:")
        guard glassView.responds(to: styleSelector) else { return }
        typealias StyleSetter = @convention(c) (AnyObject, Selector, Int) -> Void
        let implementation = glassView.method(for: styleSelector)
        let setter = unsafeBitCast(implementation, to: StyleSetter.self)
        setter(glassView, styleSelector, style.rawNSGlassEffectViewStyle)
    }

    private static func ensureTintOverlay(on glassView: NSView, window: NSWindow) -> NSView {
        if let tintOverlay = objc_getAssociatedObject(window, &tintOverlayKey) as? NSView {
            return tintOverlay
        }

        let tintOverlay = NSView(frame: glassView.bounds)
        tintOverlay.translatesAutoresizingMaskIntoConstraints = false
        tintOverlay.wantsLayer = true
        glassView.addSubview(tintOverlay)
        NSLayoutConstraint.activate([
            tintOverlay.topAnchor.constraint(equalTo: glassView.topAnchor),
            tintOverlay.bottomAnchor.constraint(equalTo: glassView.bottomAnchor),
            tintOverlay.leadingAnchor.constraint(equalTo: glassView.leadingAnchor),
            tintOverlay.trailingAnchor.constraint(equalTo: glassView.trailingAnchor)
        ])
        objc_setAssociatedObject(window, &tintOverlayKey, tintOverlay, .OBJC_ASSOCIATION_RETAIN)
        return tintOverlay
    }

    static func remove(from window: NSWindow) {
        guard let glassView = objc_getAssociatedObject(window, &glassViewKey) as? NSView else {
            return
        }

        if glassView.className == "NSGlassEffectView" {
            if let originalContentView = objc_getAssociatedObject(window, &originalContentViewKey) as? NSView {
                originalContentView.removeFromSuperview()
                originalContentView.translatesAutoresizingMaskIntoConstraints = true
                originalContentView.autoresizingMask = [.width, .height]
                originalContentView.frame = glassView.bounds
                window.contentView = originalContentView
            }
        } else {
            glassView.removeFromSuperview()
        }

        objc_setAssociatedObject(window, &glassViewKey, nil, .OBJC_ASSOCIATION_RETAIN)
        objc_setAssociatedObject(window, &originalContentViewKey, nil, .OBJC_ASSOCIATION_RETAIN)
        objc_setAssociatedObject(window, &tintOverlayKey, nil, .OBJC_ASSOCIATION_RETAIN)
    }
}
