import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Riftbound Market Watch",
  description: "TCGplayer prices for every released Riftbound card.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        <div className="mx-auto max-w-6xl px-6 py-10">{children}</div>
      </body>
    </html>
  );
}
