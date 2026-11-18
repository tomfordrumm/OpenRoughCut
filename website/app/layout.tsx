import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.png", metadataBase).toString();

  return {
    title: "OpenRoughCut — Cut the silence. Keep the story.",
    description: "A free, local-first desktop tool that finds silence, false starts, and repeated takes—then exports an editable timeline.",
    metadataBase,
    openGraph: {
      title: "OpenRoughCut — Cut the silence. Keep the story.",
      description: "Local-first rough cuts for Final Cut Pro, Premiere Pro, and DaVinci Resolve.",
      type: "website",
      images: [{ url: socialImage, width: 1792, height: 1024, alt: "OpenRoughCut — Cut the silence. Keep the story." }],
    },
    twitter: {
      card: "summary_large_image",
      title: "OpenRoughCut — Cut the silence. Keep the story.",
      description: "Local-first rough cuts that remain fully editable.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
