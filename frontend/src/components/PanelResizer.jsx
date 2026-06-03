import { useEffect, useRef } from "react";

export default function PanelResizer({ onResize, disabled = false, ariaLabel = "Resize panel" }) {
  const draggingRef = useRef(false);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  useEffect(() => {
    const handleMove = (event) => {
      if (!draggingRef.current || disabled) return;
      onResizeRef.current(event.movementX);
    };

    const endDrag = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.classList.remove("panel-resize-active");
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      document.body.classList.remove("panel-resize-active");
    };
  }, [disabled]);

  const startDrag = (event) => {
    if (disabled) return;
    event.preventDefault();
    draggingRef.current = true;
    document.body.classList.add("panel-resize-active");
  };

  return (
    <div
      className={`panel-resizer${disabled ? " panel-resizer--disabled" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onPointerDown={startDrag}
    />
  );
}
