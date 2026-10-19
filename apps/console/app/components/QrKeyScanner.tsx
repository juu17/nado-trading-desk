"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Text } from "@cloudflare/kumo";
import { CameraIcon, StopIcon } from "@phosphor-icons/react";

/** Normalize a scanned string to a 0x-prefixed 64-hex EVM private key, or null if it isn't one.
 *  Accepts the raw 64 hex or a 0x-prefixed form; the final curve-range check is wative's on import. */
function normalizePrivateKey(s: string): string | null {
  const m = s.trim().match(/^(?:0x)?([0-9a-fA-F]{64})$/);
  return m ? `0x${m[1]}` : null;
}

// BarcodeDetector is a browser-native API (Chromium); not in lib.dom, so declare the slice we use.
interface BarcodeDetectorLike { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }
interface BarcodeDetectorCtor { new (opts?: { formats?: string[] }): BarcodeDetectorLike }

/** Import a private key WITHOUT the clipboard: click → browser camera-permission prompt → live QR
 *  scan → on a QR that decodes to a valid EVM private key, calls onKey(key) and stops the camera.
 *  Falls back with a clear message when the browser has no BarcodeDetector / camera. */
export function QrKeyScanner({ onKey, disabled }: { onKey: (key: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const stop = () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setOpen(false);
  };
  useEffect(() => () => stop(), []); // stop the camera if the block unmounts mid-scan

  const start = async () => {
    setErr(null);
    const Ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    if (!Ctor) { setErr("QR scanning isn't supported in this browser — paste the key instead."); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setErr("No camera available in this browser."); return; }
    setOpen(true);
    try {
      // Prompts for camera approval the first time, then opens directly. Rear camera when present.
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) { stop(); return; }
      v.srcObject = stream;
      await v.play();
      const detector = new Ctor({ formats: ["qr_code"] });
      const tick = async () => {
        if (!streamRef.current || !videoRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          const hit = codes.map((c) => normalizePrivateKey(c.rawValue)).find(Boolean);
          if (hit) { onKey(hit); stop(); return; }           // valid private key → hand it off, no clipboard
          if (codes.length) setErr("Scanned QR is not a private key — keep the key's QR in frame.");
        } catch { /* transient per-frame decode error — keep scanning */ }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      setErr("Camera access denied or unavailable.");
      stop();
    }
  };

  return (
    <div className="flex flex-col items-start gap-1.5">
      {open ? (
        <>
          <video ref={videoRef} muted playsInline className="w-full max-w-xs rounded-lg bg-kumo-recessed ring ring-kumo-line" />
          <Button size="sm" icon={StopIcon} onClick={stop}>Stop camera</Button>
        </>
      ) : (
        <Button size="sm" icon={CameraIcon} disabled={disabled} onClick={start}>Scan QR (camera)</Button>
      )}
      {!open && <Text variant="secondary" size="xs">Scan a key&apos;s QR straight from the camera — keeps it off the clipboard.</Text>}
      {err && <Text variant="error" size="xs">{err}</Text>}
    </div>
  );
}
