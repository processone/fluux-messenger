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
  privacy = PrivacyCover()
  DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
   self.privacy!.uncoverActive()
   precondition(window.subviews.last !== nil)
   let before = window.subviews.count
   self.privacy!.cover(windows: [window])
   let cover = window.subviews.last!
   precondition(cover.isOpaque && cover.backgroundColor == .systemBackground && cover.frame == window.bounds)
   precondition(cover.superview === window && cover.accessibilityElementsHidden)
   self.privacy!.cover(windows: [window])
   precondition(window.subviews.last === cover && window.subviews.count == before + 1)
   self.privacy!.uncoverActive()
   precondition(cover.superview == nil && window.subviews.count == before)
   NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
   precondition(window.subviews.count == before + 1)
   NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
   precondition(window.subviews.count == before)
   let sceneA = FixtureScene(session: session, connectionOptions: options)
   let sceneB = FixtureScene(session: session, connectionOptions: options)
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
   print("PRIVACY_FIXTURE_PASSED")
   fflush(stdout)
   exit(0)
  }
 }
}
