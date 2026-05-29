import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Multilingual Text Map",
  description: "Screen-based multilingual QA mapping MVP",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
