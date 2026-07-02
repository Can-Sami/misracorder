// Misracorder audio routing helper (CoreAudio).
//
// Commands:
//   check                 -> {"blackhole": bool}            is a loopback input present?
//   begin                 -> {"ok",original,bluetooth,...}  route output through BlackHole
//   end <originalUID>      -> {"ok": true}                   restore output, tear down
//   cleanup [originalUID]  -> {"ok",cleaned}                 crash recovery on launch
//
// "begin" builds a Multi-Output Device ("Misracorder Output") containing whatever the
// user is currently listening on (the master, so listening stays clean) plus BlackHole,
// and makes it the default output so system audio also reaches BlackHole for capture.
// "end" puts the original output device back and destroys the Multi-Output Device.

import Foundation
import CoreAudio
import CoreGraphics
import AppKit
import ApplicationServices

let kSys = AudioObjectID(kAudioObjectSystemObject)
let AGG_UID = "com.misracorder.multiout"

func devices() -> [AudioObjectID] {
    var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(kSys, &a, 0, nil, &size)
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    if size > 0 { AudioObjectGetPropertyData(kSys, &a, 0, nil, &size, &ids) }
    return ids
}

func cfStr(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
    var a = AudioObjectPropertyAddress(mSelector: sel,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var ref: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let st = withUnsafeMutablePointer(to: &ref) {
        $0.withMemoryRebound(to: UInt8.self, capacity: Int(size)) {
            AudioObjectGetPropertyData(id, &a, 0, nil, &size, $0)
        }
    }
    return st == noErr ? (ref?.takeRetainedValue() as String?) : nil
}

func name(_ id: AudioObjectID) -> String { cfStr(id, kAudioObjectPropertyName) ?? "" }
func uid(_ id: AudioObjectID) -> String { cfStr(id, kAudioDevicePropertyDeviceUID) ?? "" }

func channels(_ id: AudioObjectID, _ scope: AudioObjectPropertyScope) -> Int {
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: scope, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    if AudioObjectGetPropertyDataSize(id, &a, 0, nil, &size) != noErr || size == 0 { return 0 }
    let p = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 16); defer { p.deallocate() }
    AudioObjectGetPropertyData(id, &a, 0, nil, &size, p)
    return UnsafeMutableAudioBufferListPointer(p.assumingMemoryBound(to: AudioBufferList.self))
        .reduce(0) { $0 + Int($1.mNumberChannels) }
}

func transport(_ id: AudioObjectID) -> UInt32 {
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var t: UInt32 = 0; var size = UInt32(MemoryLayout<UInt32>.size)
    AudioObjectGetPropertyData(id, &a, 0, nil, &size, &t)
    return t
}
func isBluetooth(_ id: AudioObjectID) -> Bool {
    let t = transport(id)
    return t == kAudioDeviceTransportTypeBluetooth || t == kAudioDeviceTransportTypeBluetoothLE
}

func defaultOutput() -> AudioObjectID {
    var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var dev: AudioObjectID = 0; var size = UInt32(MemoryLayout<AudioObjectID>.size)
    AudioObjectGetPropertyData(kSys, &a, 0, nil, &size, &dev)
    return dev
}
@discardableResult
func setDefaultOutput(_ id: AudioObjectID) -> Bool {
    var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var dev = id
    return AudioObjectSetPropertyData(kSys, &a, 0, nil, UInt32(MemoryLayout<AudioObjectID>.size), &dev) == noErr
}

func deviceByUID(_ u: String) -> AudioObjectID? { u.isEmpty ? nil : devices().first { uid($0) == u } }

// Output data source (e.g. headphones 'hdpn' vs internal speakers 'ispk') — present
// on Macs that expose the headphone jack as a data source of the built-in device
// rather than a separate device. Returns nil when the device has no selectable source.
func outputDataSource(_ id: AudioObjectID) -> UInt32? {
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDataSource,
        mScope: kAudioObjectPropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    if !AudioObjectHasProperty(id, &a) { return nil }
    var v: UInt32 = 0; var s = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(id, &a, 0, nil, &s, &v) == noErr ? v : nil
}
@discardableResult
func setOutputDataSource(_ id: AudioObjectID, _ value: UInt32) -> Bool {
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDataSource,
        mScope: kAudioObjectPropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    if !AudioObjectHasProperty(id, &a) { return false }
    var v = value
    return AudioObjectSetPropertyData(id, &a, 0, nil, UInt32(MemoryLayout<UInt32>.size), &v) == noErr
}
func isLoopbackName(_ n: String) -> Bool {
    let s = n.lowercased()
    return s.contains("blackhole") || s.contains("loopback") || s.contains("soundflower")
}
func blackHoleOutputUID() -> String? {
    devices().first { channels($0, kAudioObjectPropertyScopeOutput) > 0 && isLoopbackName(name($0)) }.map(uid)
}
func blackHolePresent() -> Bool {
    devices().contains { channels($0, kAudioObjectPropertyScopeInput) > 0 && isLoopbackName(name($0)) }
}
func builtinOutputUID() -> String? {
    if let d = devices().first(where: { channels($0, kAudioObjectPropertyScopeOutput) > 0 && transport($0) == kAudioDeviceTransportTypeBuiltIn }) {
        return uid(d)
    }
    return devices().first { channels($0, kAudioObjectPropertyScopeOutput) > 0 && !isLoopbackName(name($0)) && uid($0) != AGG_UID }.map(uid)
}
func ourAggregate() -> AudioObjectID? { devices().first { uid($0) == AGG_UID } }

// --- volume (so we can drive the real device while a Multi-Output is the default) ---
func getVol(_ id: AudioObjectID, _ el: AudioObjectPropertyElement) -> Float32? {
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar,
        mScope: kAudioObjectPropertyScopeOutput, mElement: el)
    if !AudioObjectHasProperty(id, &a) { return nil }
    var v: Float32 = 0; var s = UInt32(MemoryLayout<Float32>.size)
    return AudioObjectGetPropertyData(id, &a, 0, nil, &s, &v) == noErr ? v : nil
}
@discardableResult
func setVol(_ id: AudioObjectID, _ el: AudioObjectPropertyElement, _ value: Float32) -> Bool {
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar,
        mScope: kAudioObjectPropertyScopeOutput, mElement: el)
    if !AudioObjectHasProperty(id, &a) { return false }
    var v = value
    return AudioObjectSetPropertyData(id, &a, 0, nil, UInt32(MemoryLayout<Float32>.size), &v) == noErr
}
func getMute(_ id: AudioObjectID) -> Bool? {
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute,
        mScope: kAudioObjectPropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    if !AudioObjectHasProperty(id, &a) { return nil }
    var v: UInt32 = 0; var s = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(id, &a, 0, nil, &s, &v) == noErr ? (v != 0) : nil
}
@discardableResult
func setMute(_ id: AudioObjectID, _ on: Bool) -> Bool {
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute,
        mScope: kAudioObjectPropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    if !AudioObjectHasProperty(id, &a) { return false }
    var v: UInt32 = on ? 1 : 0
    return AudioObjectSetPropertyData(id, &a, 0, nil, UInt32(MemoryLayout<UInt32>.size), &v) == noErr
}
// Read the current output volume (master, else average of channels).
func currentVolume(_ id: AudioObjectID) -> Float32? {
    if let m = getVol(id, kAudioObjectPropertyElementMain) { return m }
    let chans = [getVol(id, 1), getVol(id, 2)].compactMap { $0 }
    return chans.isEmpty ? nil : chans.reduce(0, +) / Float32(chans.count)
}

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: data, encoding: .utf8) { print(s); fflush(stdout) }
}

// --- media-key listener (so the hardware volume keys drive the real device while a
// --- Multi-Output Device, which has no volume, is the system default) ----------
var listenDevice: AudioObjectID = 0
func bumpVolume(_ dev: AudioObjectID, _ delta: Float32) {
    if delta > 0 { setMute(dev, false) } // raising unmutes
    var nv: Float32 = -1
    if let cur = getVol(dev, kAudioObjectPropertyElementMain) {
        nv = min(1, max(0, cur + delta)); setVol(dev, kAudioObjectPropertyElementMain, nv)
    } else {
        for el: AudioObjectPropertyElement in [1, 2] where getVol(dev, el) != nil {
            nv = min(1, max(0, getVol(dev, el)! + delta)); setVol(dev, el, nv)
        }
    }
    emit(["volume": nv])
}
func toggleMute(_ dev: AudioObjectID) {
    let m = !(getMute(dev) ?? false); setMute(dev, m); emit(["muted": m])
}
var eventTap: CFMachPort?
// NX_SYSDEFINED subtype 8 carries the aux/media buttons; codes: 0=up, 1=down, 7=mute.
let mediaKeyCallback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let t = eventTap { CGEvent.tapEnable(tap: t, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    if type.rawValue == 14, let ns = NSEvent(cgEvent: event), ns.subtype.rawValue == 8 {
        let keyCode = Int((ns.data1 & 0xFFFF0000) >> 16)
        let isDown = ((ns.data1 & 0x0000FF00) >> 8) == 0x0A
        if isDown {
            switch keyCode {
            case 0: bumpVolume(listenDevice, 1.0 / 16.0); return nil
            case 1: bumpVolume(listenDevice, -1.0 / 16.0); return nil
            case 7: toggleMute(listenDevice); return nil
            default: break
            }
        }
    }
    return Unmanaged.passUnretained(event)
}

let args = CommandLine.arguments
let cmd = args.count > 1 ? args[1] : ""

switch cmd {
case "check":
    emit(["blackhole": blackHolePresent()])

case "begin":
    guard let bh = blackHoleOutputUID() else { emit(["ok": false, "error": "no-blackhole"]); break }
    if let stale = ourAggregate() { AudioHardwareDestroyAggregateDevice(stale) }
    let cur = defaultOutput()
    var listenUID = uid(cur)
    // Never build on top of BlackHole or our own aggregate — fall back to a real device.
    if listenUID.isEmpty || listenUID == AGG_UID || isLoopbackName(name(cur)) {
        listenUID = builtinOutputUID() ?? listenUID
    }
    if listenUID.isEmpty { emit(["ok": false, "error": "no-output"]); break }
    let listenDev = deviceByUID(listenUID)
    let bt = listenDev.map(isBluetooth) ?? false
    let listenName = listenDev.map(name) ?? ""
    // The headphones-vs-speakers source the user is currently hearing through.
    let listenDS = listenDev.flatMap(outputDataSource)
    let desc: [String: Any] = [
        "name": "Misracorder Output", "uid": AGG_UID, "stacked": 1, "master": listenUID, "private": 0,
        "subdevices": [["uid": listenUID, "drift": 0], ["uid": bh, "drift": 1]],
    ]
    var agg: AudioDeviceID = 0
    let st = AudioHardwareCreateAggregateDevice(desc as CFDictionary, &agg)
    if st != noErr || agg == 0 { emit(["ok": false, "error": "create-failed", "status": Int(st)]); break }
    usleep(120_000) // let the device register before we switch to it
    let okset = setDefaultOutput(agg)
    // Make the Multi-Output Device play through the same source the user was on
    // (e.g. the headphone jack), not the device's default (speakers).
    if let ds = listenDS { usleep(40_000); setOutputDataSource(agg, ds) }
    // Restore token the app shuttles back to us verbatim: "UID" or "UID\tDATASOURCE".
    let token = listenDS != nil ? "\(listenUID)\t\(listenDS!)" : listenUID
    emit(["ok": okset, "original": token, "bluetooth": bt, "listen": listenName])

case "end":
    let token = args.count > 2 ? args[2] : ""
    let parts = token.split(separator: "\t", maxSplits: 1).map(String.init)
    let original = parts.first ?? ""
    let ds = parts.count > 1 ? UInt32(parts[1]) : nil
    if let d = deviceByUID(original) {
        setDefaultOutput(d)
        if let ds = ds { setOutputDataSource(d, ds) } // put the headphone/speaker source back
    } else if let b = builtinOutputUID(), let d = deviceByUID(b) {
        setDefaultOutput(d)
    }
    usleep(80_000) // let the switch settle before tearing the aggregate down
    if let agg = ourAggregate() { AudioHardwareDestroyAggregateDevice(agg) }
    emit(["ok": true])

case "cleanup":
    if let agg = ourAggregate() {
        let token = args.count > 2 ? args[2] : ""
        let parts = token.split(separator: "\t", maxSplits: 1).map(String.init)
        let restoreUID = parts.first ?? ""
        let ds = parts.count > 1 ? UInt32(parts[1]) : nil
        var target = deviceByUID(restoreUID)
        if target == nil, let b = builtinOutputUID() { target = deviceByUID(b) }
        if defaultOutput() == agg, let t = target {
            setDefaultOutput(t)
            if let ds = ds { setOutputDataSource(t, ds) }
        }
        usleep(80_000)
        AudioHardwareDestroyAggregateDevice(agg)
        emit(["ok": true, "cleaned": true])
    } else {
        emit(["ok": true, "cleaned": false])
    }

case "volume":
    // volume <deviceUID> <up|down|mute> — drive the real listening device's volume
    // while a Multi-Output Device (which has none) is the system default.
    guard let dev = deviceByUID(args.count > 2 ? args[2] : "") else { emit(["ok": false, "error": "no-device"]); break }
    let dir = args.count > 3 ? args[3] : ""
    if dir == "mute" {
        let now = getMute(dev) ?? false
        emit(["ok": setMute(dev, !now), "muted": !now])
        break
    }
    let step: Float32 = 1.0 / 16.0 // match macOS's volume increment
    let delta: Float32 = (dir == "down") ? -step : step
    if dir == "up" { setMute(dev, false) } // raising volume unmutes
    var applied: Float32 = -1
    if let cur = getVol(dev, kAudioObjectPropertyElementMain) {
        let nv = min(1, max(0, cur + delta)); setVol(dev, kAudioObjectPropertyElementMain, nv); applied = nv
    } else {
        for el: AudioObjectPropertyElement in [1, 2] {
            if let cur = getVol(dev, el) { let nv = min(1, max(0, cur + delta)); setVol(dev, el, nv); applied = nv }
        }
    }
    emit(["ok": applied >= 0, "volume": applied])

case "listen":
    // listen <deviceUID> — long-running: tap the hardware volume keys and apply them
    // to <deviceUID>. Runs until killed by the app (on recording stop). Needs the
    // Input Monitoring permission.
    guard let dev = deviceByUID(args.count > 2 ? args[2] : "") else { emit(["ok": false, "error": "no-device"]); break }
    // An ACTIVE tap (to capture AND suppress the volume keys / grayed HUD) requires
    // Accessibility. Without it, prompt and bail so the app can guide the user.
    if !AXIsProcessTrusted() {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
        emit(["ok": false, "error": "no-permission"])
        break
    }
    listenDevice = dev
    let mask = (CGEventMask(1) << 14) // NX_SYSDEFINED
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
        options: .defaultTap, eventsOfInterest: mask, callback: mediaKeyCallback, userInfo: nil) else {
        emit(["ok": false, "error": "tap-failed"])
        break
    }
    eventTap = tap
    let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    emit(["ok": true, "listening": true])
    CFRunLoopRun()

default:
    emit(["ok": false, "error": "unknown-command"])
}
