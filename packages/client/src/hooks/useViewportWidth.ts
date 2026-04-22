import { useEffect, useState } from "react";

/**
 * Hook that tracks the current viewport width.
 * Updates on window resize.
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return 1200; // SSR fallback
    return window.innerWidth;
  });

  useEffect(() => {
    const handleResize = () => {
      setWidth(window.innerWidth);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return width;
}
