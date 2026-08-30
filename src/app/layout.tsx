import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Skylark Business Intelligence",
  description: "Read-only business intelligence over live monday.com boards",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
