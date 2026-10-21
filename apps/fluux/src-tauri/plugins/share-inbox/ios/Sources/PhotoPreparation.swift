import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Reads and re-encodes the pixels of a large photo before it is sent.
///
/// When to reduce a photo, and which attempt to keep, is decided in
/// `apps/fluux/src/utils/photoReduction.ts`. This file only decodes a file
/// already on disk and writes a JPEG copy; it never overwrites the source.
enum PhotoPreparation {
    /// Still photos that may be re-encoded. PNG, GIF, WebP, image sequences and RAW stay as they are.
    static let reducibleTypes: Set<String> = [UTType.jpeg.identifier, UTType.heic.identifier, UTType.heif.identifier]
    /// Sources with more pixels are refused before any decoding.
    static let maxSourcePixels = 120_000_000

    struct Probe {
        let type: String
        /// Stored pixel dimensions, before the orientation is applied.
        let width: Int
        let height: Int
        /// True when the photo is displayed rotated a quarter turn, so its displayed width is `height`.
        let rotated: Bool
        /// A single still JPEG or HEIF image.
        let reducible: Bool
    }

    struct Encoded {
        let width: Int
        let height: Int
        let size: Int
    }

    enum Failure: Error {
        case unreadable
        case unsupported
        case encoding
    }

    private static func open(_ url: URL) -> CGImageSource? {
        CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary)
    }

    /// Reads the type and dimensions from the file header without decoding pixels.
    static func probe(_ url: URL) -> Probe? {
        guard let source = open(url) else { return nil }
        return probe(source)
    }

    private static func probe(_ source: CGImageSource) -> Probe? {
        guard let type = CGImageSourceGetType(source) as String?,
              CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0 else { return nil }
        // A HEIF photo's depth or gain-map images are auxiliary data, not extra images in this count.
        let still = CGImageSourceGetCount(source) == 1
        let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
        return Probe(type: type, width: width, height: height, rotated: (5...8).contains(orientation),
                     reducible: still && reducibleTypes.contains(type))
    }

    /// Writes a JPEG copy whose longer side is at most `maxSide`, never enlarged.
    ///
    /// The copy has the orientation applied to its pixels and its colors converted
    /// to 8-bit sRGB. No source metadata is copied, so location, capture date,
    /// camera and author fields are absent; ImageIO adds only technical fields.
    static func encode(_ url: URL, maxSide: Int, quality: Double, to destination: URL) throws -> Encoded {
        guard let source = open(url), let probe = probe(source) else { throw Failure.unreadable }
        guard probe.reducible, probe.width * probe.height <= maxSourcePixels else { throw Failure.unsupported }
        var options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: min(maxSide, max(probe.width, probe.height)),
            kCGImageSourceShouldCacheImmediately: true,
        ]
        if #available(iOS 17, macOS 14, *) {
            // Tone-map HDR sources explicitly: the copy is a plain SDR JPEG.
            options[kCGImageSourceDecodeRequest] = kCGImageSourceDecodeToSDR
        }
        guard let decoded = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let srgb = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: decoded.width, height: decoded.height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: srgb, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
            throw Failure.unreadable
        }
        let bounds = CGRect(x: 0, y: 0, width: decoded.width, height: decoded.height)
        // Drawing converts Display P3 and other profiles into sRGB pixels rather than relabelling them.
        context.setFillColor(CGColor(colorSpace: srgb, components: [1, 1, 1, 1])!)
        context.fill(bounds)
        context.draw(decoded, in: bounds)
        guard let image = context.makeImage(),
              let output = CGImageDestinationCreateWithURL(destination as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw Failure.encoding
        }
        CGImageDestinationAddImage(output, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(output),
              let size = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize else {
            try? FileManager.default.removeItem(at: destination)
            throw Failure.encoding
        }
        return Encoded(width: image.width, height: image.height, size: size)
    }
}
