import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "PreLaunch Check — one-click pre-launch audit",
  description:
    "Paste a URL, get an automated pre-launch audit: leaked secrets, missing auth, insecure headers, SEO gaps. Free scans, shareable reports.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          background: "#0b0f14",
          color: "#e8edf2",
        }}
      >
        {children}
      </body>
    </html>
  );
}
