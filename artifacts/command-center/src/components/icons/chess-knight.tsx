import { forwardRef, type SVGProps } from "react";

export const ChessKnight = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(
  function ChessKnight(props, ref) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...props}
      >
        <path d="M14.5 3c2 1 3.5 3 4 5.5.5 2.5.5 4.5 0 7-.3 1.5-.9 2.7-1.7 3.5" />
        <path d="M14.5 3c-2.5-.6-5 .2-6.5 2L7 6.5 5.5 9c-.4.7-1 1.3-1.7 1.6L3 11" />
        <path d="M3 11c1.2.4 2.4.2 3.4-.5l.6-.4" />
        <path d="M7 10.5c.4 1.1 1.4 1.9 2.6 2 .8 0 1.5-.3 2-.8" />
        <path d="M9 13c-.5.8-.8 1.7-.8 2.6 0 .8.3 1.7.8 2.4" />
        <circle cx="11.5" cy="7.5" r=".7" fill="currentColor" stroke="none" />
        <path d="M7 19h11l1 2H6z" />
        <path d="M8 19v-1c0-2 1-3.5 2.5-5" />
        <path d="M17 19v-1c0-2 .5-4 .5-6" />
      </svg>
    );
  },
);
