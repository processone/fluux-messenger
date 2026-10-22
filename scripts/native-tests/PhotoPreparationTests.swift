import Foundation
import ImageIO

// Intent: the reduced copy the captain accepted in FLM-22 is a real JPEG with its
// orientation applied, sRGB colors and none of the source's personal metadata.
// Runs the production PhotoPreparation.swift on real photos from FLUUX_PHOTO_FIXTURES.
@main struct PhotoPreparationTests {
    static func properties(_ url: URL) -> [CFString: Any] {
        let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
        return CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as! [CFString: Any]
    }

    static func main() {
        let fixtures = URL(fileURLWithPath: CommandLine.arguments[1])
        let output = URL(fileURLWithPath: CommandLine.arguments[2])
        let files = try! FileManager.default.contentsOfDirectory(at: fixtures, includingPropertiesForKeys: nil)
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for file in files {
            let name = file.lastPathComponent
            guard let probe = PhotoPreparation.probe(file) else {
                print("UNREADABLE \(name)")
                continue
            }
            let destination = output.appendingPathComponent("\(name).jpg")
            guard probe.reducible else {
                precondition((try? PhotoPreparation.encode(file, maxSide: 2560, quality: 0.85, to: destination)) == nil,
                             "\(name): only still JPEG and HEIF photos are re-encoded")
                print("UNTOUCHED \(name) \(probe.type)")
                continue
            }
            let encoded = try! PhotoPreparation.encode(file, maxSide: 2560, quality: 0.85, to: destination)
            let copy = properties(destination)
            let source = CGImageSourceCreateWithURL(destination as CFURL, nil)!
            precondition(CGImageSourceGetType(source) as String? == "public.jpeg", "\(name): the copy is a JPEG")
            let (width, height) = probe.rotated ? (probe.height, probe.width) : (probe.width, probe.height)
            precondition(max(encoded.width, encoded.height) == min(2560, max(width, height)), "\(name): long side bounded, never enlarged")
            precondition((encoded.width > encoded.height) == (width > height), "\(name): the orientation is applied to the pixels")
            precondition(copy[kCGImagePropertyPixelWidth] as? Int == encoded.width, "\(name): reported width matches")
            precondition((copy[kCGImagePropertyOrientation] as? Int ?? 1) == 1, "\(name): no orientation left to apply")
            precondition(copy[kCGImagePropertyGPSDictionary] == nil, "\(name): no location")
            let tiff = copy[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
            precondition(tiff[kCGImagePropertyTIFFMake] == nil && tiff[kCGImagePropertyTIFFModel] == nil, "\(name): no camera")
            let exif = copy[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
            precondition(exif[kCGImagePropertyExifDateTimeOriginal] == nil && exif[kCGImagePropertyExifLensModel] == nil,
                         "\(name): no capture date or lens")
            precondition(copy[kCGImagePropertyIPTCDictionary] == nil, "\(name): no IPTC")
            precondition((copy[kCGImagePropertyProfileName] as? String)?.contains("sRGB") == true, "\(name): sRGB colors")
            let bytes = try! destination.resourceValues(forKeys: [.fileSizeKey]).fileSize!
            precondition(bytes == encoded.size, "\(name): reported size matches the file")
            print("REDUCED \(name) \(width)x\(height) -> \(encoded.width)x\(encoded.height) \(encoded.size) bytes")
        }
    }
}
