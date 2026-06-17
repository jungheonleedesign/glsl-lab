"use client";

import dynamic from "next/dynamic";

const ShaderCanvas = dynamic(() => import("@/components/ShaderCanvas"), {
  ssr: false,
});

export default function ClientHome() {
  return (
    <main className="w-full h-full">
      <ShaderCanvas />
    </main>
  );
}
