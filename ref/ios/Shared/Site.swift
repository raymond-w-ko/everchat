// Site
// ====
// The server the app is a view of (Info.plist UniiSite), and a request to
// it as the user signed in: the app keeps the site's sign-in cookie in
// the app group, which the share extension reads too. The answer is the
// server's JSON, or {error}, as the site's own post() reads it.

import Foundation

enum Site {

  static let url = URL(string: Bundle.main.object(forInfoDictionaryKey: "UniiSite") as! String)!
  static let group = UserDefaults(suiteName: "group.com.raymondwko.everchat")!

  // a GET (body nil) or POST of `body`
  static func call(_ path: String, _ body: Data?) async -> [String: Any] {
    var req = URLRequest(url: URL(string: path, relativeTo: url)!)
    req.httpMethod = body == nil ? "GET" : "POST"
    req.httpBody = body
    req.setValue("Bearer " + (group.string(forKey: "session") ?? ""), forHTTPHeaderField: "Authorization")
    guard let (data, res) = try? await URLSession.shared.data(for: req) else {
      return ["error": "Can't reach UniiChat. Try again."]
    }
    if (res as? HTTPURLResponse)?.statusCode == 401 {
      return ["error": "Open UniiChat and sign in first."]
    }
    let out = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    return out ?? ["error": "UniiChat gave no answer. Try again."]
  }

}
