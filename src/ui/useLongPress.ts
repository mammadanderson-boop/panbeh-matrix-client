import { useRef, type MouseEvent, type TouchEvent } from "react";

const LONG_PRESS = 500;

/** Right-click or a held finger calls `onMenu` (none = no menu). Wrap the row's onClick in `click` so the tap that ends a
 *  long-press doesn't also open the row. iOS Safari fires no contextmenu on long-press, hence the touch timer. */
export function useLongPress(onMenu?: (x: number, y: number) => void) {
  const press = useRef<{ timer: number; fired: boolean } | null>(null);
  const cancel = () => { if (press.current) clearTimeout(press.current.timer); };
  return {
    click: (fn: () => void) => () => { if (press.current?.fired) press.current = null; else fn(); },
    handlers: onMenu ? {
      onContextMenu: (e: MouseEvent) => { e.preventDefault(); cancel(); onMenu(e.clientX, e.clientY); },
      onTouchStart: (e: TouchEvent) => {
        const { clientX: x, clientY: y } = e.touches[0];
        cancel();
        press.current = { fired: false, timer: window.setTimeout(() => { press.current!.fired = true; onMenu(x, y); }, LONG_PRESS) };
      },
      onTouchMove: cancel,
      onTouchEnd: cancel,
    } : {},
  };
}
