import "@testing-library/jest-dom/vitest";

// Enable React's act() environment so state-update warnings are clean and
// our explicit `act(...)` wrappers in tests behave correctly.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;
