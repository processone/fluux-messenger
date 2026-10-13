import UIKit
final class FixtureScene: UIWindowScene {
 var fixtureWindows: [UIWindow] = []
 var fixtureState: UIScene.ActivationState = .foregroundActive
 override var windows: [UIWindow] { fixtureWindows }
 override var activationState: UIScene.ActivationState { fixtureState }
}
final class FixtureWindow: UIWindow {
 var fixtureScene: UIWindowScene?
 override var windowScene: UIWindowScene? {
  get { fixtureScene }
  set { fixtureScene = newValue }
 }
}
@main final class FixtureDelegate: UIResponder, UIApplicationDelegate {
 func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
  let configuration = UISceneConfiguration(name: "Fixture", sessionRole: session.role)
  configuration.delegateClass = FixtureSceneDelegate.self
  return configuration
 }
}
final class FixtureSceneDelegate: UIResponder, UIWindowSceneDelegate {
 var window: UIWindow?
 var privacy: PrivacyCover?
 func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
  let window = UIWindow(windowScene: scene as! UIWindowScene)
  let controller = UIViewController()
  controller.view.backgroundColor = .systemRed
  let label = UILabel(frame: CGRect(x: 25, y: 100, width: 350, height: 70))
  label.text = "SYNTHETIC PRIVATE CHAT"
  controller.view.addSubview(label)
  window.rootViewController = controller
  self.window = window
  window.makeKeyAndVisible()
  var applicationScenes = [scene as! UIWindowScene]
  let logo = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
   UIColor.systemBlue.setFill()
   context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
  }
  privacy = PrivacyCover(applicationScenes: { applicationScenes }, logo: logo)
  DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
   self.privacy!.uncoverActive()
   precondition(window.subviews.last !== nil)
   let before = window.subviews.count
   self.privacy!.cover(windows: [window])
   let cover = window.subviews.last!
   let blur = cover as! UIVisualEffectView
   precondition(blur.effect is UIBlurEffect && cover.frame == window.bounds)
   cover.layoutIfNeeded()
   let image = blur.contentView.subviews.compactMap { $0 as? UIImageView }.first!
   precondition(image.image === logo && image.center == blur.contentView.center)
   precondition(cover.overrideUserInterfaceStyle == .unspecified, "The cover follows the system until the app sets a theme")
   self.privacy!.appearance = .dark
   precondition(cover.overrideUserInterfaceStyle == .dark, "A theme change must reach a cover already shown")
   precondition(cover.superview === window && cover.accessibilityElementsHidden)
   self.privacy!.cover(windows: [window])
   precondition(window.subviews.last === cover && window.subviews.count == before + 1)
   self.privacy!.uncoverActive()
   precondition(cover.superview == nil && window.subviews.count == before)
   self.privacy!.cover(windows: [window])
   precondition(window.subviews.last!.overrideUserInterfaceStyle == .dark, "A new cover must use the app's theme")
   self.privacy!.appearance = .unspecified
   self.privacy!.uncoverActive()
   precondition(window.subviews.count == before)
   NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
   precondition(window.subviews.count == before + 1)
   NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
   precondition(window.subviews.count == before)
   NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
   precondition(window.subviews.count == before + 1)
   NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
   precondition(window.subviews.count == before, "A returning app must be uncovered before it becomes active")
   NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
   precondition(window.subviews.count == before + 1, "An app leaving before it becomes active must be covered for its snapshot")
   NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
   precondition(window.subviews.count == before)
   let sceneA = FixtureScene(session: session, connectionOptions: options)
   let sceneB = FixtureScene(session: session, connectionOptions: options)
   applicationScenes.append(contentsOf: [sceneA, sceneB])
   let windowA = FixtureWindow(frame: window.bounds)
   let windowB = FixtureWindow(frame: window.bounds)
   windowA.fixtureScene = sceneA
   windowB.fixtureScene = sceneB
   sceneA.fixtureWindows = [windowA]
   sceneB.fixtureWindows = [windowB]
   windowA.isHidden = false
   windowB.isHidden = false
   self.privacy!.uncoverActive(windows: [windowA, windowB])
   let countA = windowA.subviews.count
   let countB = windowB.subviews.count
   let center = NotificationCenter.default
   center.post(name: UIScene.willDeactivateNotification, object: sceneA)
   precondition(windowA.subviews.count == countA + 1 && windowB.subviews.count == countB)
   center.post(name: UIScene.didActivateNotification, object: sceneA)
   precondition(windowA.subviews.count == countA)
   center.post(name: UIScene.willDeactivateNotification, object: sceneA)
   center.post(name: UIScene.willDeactivateNotification, object: sceneB)
   center.post(name: UIScene.willEnterForegroundNotification, object: sceneA)
   precondition(windowA.subviews.count == countA && windowB.subviews.count == countB + 1,
    "A scene returning to the foreground must uncover only its own windows")
   center.post(name: UIScene.didEnterBackgroundNotification, object: sceneA)
   precondition(windowA.subviews.count == countA + 1, "A scene leaving before it becomes active must be covered")
   center.post(name: UIScene.didActivateNotification, object: sceneA)
   precondition(windowA.subviews.count == countA)
   center.post(name: UIScene.didActivateNotification, object: sceneB)
   precondition(windowB.subviews.count == countB)
   sceneA.fixtureState = .foregroundInactive
   center.post(name: UIWindow.didBecomeVisibleNotification, object: windowA)
   precondition(windowA.subviews.count == countA + 1)
   center.post(name: UIWindow.didBecomeVisibleNotification, object: windowB)
   precondition(windowB.subviews.count == countB)
   self.privacy!.uncoverActive()
   precondition(windowA.subviews.count == countA + 1)
   center.post(name: UIWindow.didBecomeVisibleNotification, object: windowA)
   precondition(windowA.subviews.count == countA + 1)
   center.post(name: UIScene.willDeactivateNotification, object: sceneB)
   precondition(windowB.subviews.count == countB + 1)
   sceneA.fixtureState = .foregroundActive
   center.post(name: UIScene.didActivateNotification, object: sceneA)
   precondition(windowA.subviews.count == countA && windowB.subviews.count == countB + 1)
   center.post(name: UIScene.didActivateNotification, object: sceneB)
   precondition(windowB.subviews.count == countB)
   let keyboardScene = FixtureScene(session: session, connectionOptions: options)
   keyboardScene.fixtureState = .foregroundInactive
   let keyboardWindow = FixtureWindow(frame: window.bounds)
   keyboardWindow.fixtureScene = keyboardScene
   keyboardScene.fixtureWindows = [keyboardWindow]
   let keyboardSubviewCount = keyboardWindow.subviews.count
   keyboardWindow.isHidden = false
   center.post(name: UIWindow.didBecomeVisibleNotification, object: keyboardWindow)
   precondition(keyboardWindow.subviews.count == keyboardSubviewCount,
    "Privacy cover must not obscure a UIKit-owned keyboard scene while the app is active")
   center.post(name: UIScene.willDeactivateNotification, object: keyboardScene)
   precondition(keyboardWindow.subviews.count == keyboardSubviewCount,
    "Privacy cover must ignore deactivation of a scene the application does not own")
   self.privacy!.cover(windows: [keyboardWindow])
   precondition(keyboardWindow.subviews.count == keyboardSubviewCount,
    "Explicit privacy coverage must also ignore UIKit-owned scenes")
   print("PRIVACY_FIXTURE_PASSED")
   fflush(stdout)
   exit(0)
  }
 }
}
