import type { Metadata } from "next";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
export const metadata: Metadata = {
  title: "Solaris — Test AI agents through evidence",
  description:
    "Evaluate AI agents on computer tasks, inspect saved evidence, and compare reliability across attempts.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
