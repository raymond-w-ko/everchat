// Share
// =====
// UniiChat in the share sheet: a page, a text or images shared go to
// the chat as one message, under a note typed above them: one post to
// /api/act, the site's say act (its id made once, so a Send tapped again
// is taken once; its images, sizes given, then its text), with the app's
// sign-in (Site.swift). An image the server doesn't read (a photo's
// HEIC) goes as a JPEG.

import ImageIO
import SwiftUI
import UIKit
import UniformTypeIdentifiers

final class Share: UIViewController {

  override func viewDidLoad() {
    super.viewDidLoad()
    let items = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    let done: () -> Void = { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }
    let host = UIHostingController(rootView: Compose(items: items, done: done))
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
  }

}

struct Compose: View {

  let items: [NSItemProvider]
  let done: () -> Void

  @State var note = ""
  @State var error: String? = nil
  @State var sending = false
  @State var id = UUID().uuidString.lowercased()

  var body: some View {
    NavigationStack {
      Form {
        TextField("Add a note", text: $note, axis: .vertical)
        Text(items.count == 1 ? "1 item" : "\(items.count) items").foregroundStyle(.secondary)
        if let error {
          Text(error).foregroundStyle(.red)
        }
      }
      .navigationTitle("UniiChat")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: done)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Send") {
            Task {
              sending = true
              error = await send(items, note, id)
              sending = false
              if error == nil {
                done()
              }
            }
          }
          .disabled(sending)
        }
      }
    }
  }

}

// the message posted; nil, or why not
func send(_ items: [NSItemProvider], _ note: String, _ id: String) async -> String? {
  var lines = [note]
  var body = Data()
  var sizes: [String] = []
  for item in items {
    if item.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
      guard let data = await image(item) else {
        return "An image couldn't be read."
      }
      body.append(data)
      sizes.append(String(data.count))
    } else if let url = try? await item.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
      lines.append(url.absoluteString)
    } else if let text = try? await item.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
      lines.append(text)
    }
  }
  body.append(Data(lines.filter { !$0.isEmpty }.joined(separator: "\n\n").utf8))
  return await Site.call("/api/act?$=say&id=" + id + "&sizes=" + sizes.joined(separator: ","), body)["error"] as? String
}

// an image's bytes: as they are if the server reads its kind, else a JPEG
func image(_ item: NSItemProvider) async -> Data? {
  let read: [UTType] = [.png, .jpeg, .gif, .webP]
  let kind = read.first { item.hasItemConformingToTypeIdentifier($0.identifier) }
  let data = await withCheckedContinuation { (done: CheckedContinuation<Data?, Never>) in
    _ = item.loadDataRepresentation(forTypeIdentifier: (kind ?? .image).identifier) { data, _ in
      done.resume(returning: data)
    }
  }
  guard kind == nil, let data, let src = CGImageSourceCreateWithData(data as CFData, nil) else {
    return data
  }
  let out = NSMutableData()
  guard let dst = CGImageDestinationCreateWithData(out as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else {
    return nil
  }
  CGImageDestinationAddImageFromSource(dst, src, 0, nil)
  return CGImageDestinationFinalize(dst) ? out as Data : nil
}
