import * as rt from "react/jsx-dev-runtime";
import { withEmoji } from "./jsx-runtime.ts";

export { Fragment } from "react";
export const jsxDEV: typeof rt.jsxDEV = (type, props, key, isStatic, source, self) => rt.jsxDEV(type, withEmoji(type, props), key, isStatic, source, self);
