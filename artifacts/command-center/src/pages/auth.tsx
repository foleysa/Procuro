import { SignIn, SignUp } from "@clerk/react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Wrapper around the Clerk-hosted `<SignIn>` component. The `path` prop
 * MUST be the absolute browser URL — Clerk reads `window.location.pathname`
 * directly, so we have to include the artifact base path even though the
 * surrounding wouter router is base-aware.
 */
export function SignInPage() {
  return (
    <div
      data-testid="page-sign-in"
      className="flex min-h-[100dvh] items-center justify-center bg-background px-4"
    >
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        forceRedirectUrl={`${basePath}/`}
      />
    </div>
  );
}

export function SignUpPage() {
  return (
    <div
      data-testid="page-sign-up"
      className="flex min-h-[100dvh] items-center justify-center bg-background px-4"
    >
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        forceRedirectUrl={`${basePath}/`}
      />
    </div>
  );
}
