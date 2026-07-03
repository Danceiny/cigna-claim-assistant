#!/usr/bin/env swift
import AppKit
import Foundation
import PDFKit
import Vision

guard CommandLine.arguments.count >= 2 else {
  fputs("usage: macos-vision-ocr.swift <pdf-or-image>\n", stderr)
  exit(2)
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let ext = inputURL.pathExtension.lowercased()
let images: [CGImage]

if ext == "pdf" {
  guard let document = PDFDocument(url: inputURL) else {
    fputs("unable to read PDF\n", stderr)
    exit(3)
  }
  images = (0..<document.pageCount).compactMap { index in
    guard let page = document.page(at: index) else { return nil }
    return renderPDFPage(page)
  }
} else {
  guard let image = NSImage(contentsOf: inputURL), let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fputs("unable to read image\n", stderr)
    exit(3)
  }
  images = [cgImage]
}

var allText: [String] = []
for image in images {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["en-US"]
  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  try handler.perform([request])
  let lines = (request.results ?? [])
    .compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
  allText.append(contentsOf: lines)
}

print(allText.joined(separator: "\n"))

func renderPDFPage(_ page: PDFPage) -> CGImage? {
  let bounds = page.bounds(for: .mediaBox)
  let scale: CGFloat = 2.5
  let width = max(1, Int(bounds.width * scale))
  let height = max(1, Int(bounds.height * scale))
  guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: width,
    pixelsHigh: height,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else {
    return nil
  }
  rep.size = NSSize(width: bounds.width, height: bounds.height)
  guard let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = context
  NSColor.white.set()
  NSRect(origin: .zero, size: rep.size).fill()
  page.draw(with: .mediaBox, to: context.cgContext)
  NSGraphicsContext.restoreGraphicsState()
  return rep.cgImage
}
