import type { Metadata } from "next";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
export const metadata: Metadata = {
  title: "Gauntlet — Evaluation workspace",
  description:
    "Inspect computer-use evaluations, evidence, and local harness health.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
