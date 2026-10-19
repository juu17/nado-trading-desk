"use client";

import { forwardRef } from "react";
import NextLink from "next/link";
import type { LinkComponentProps } from "@cloudflare/kumo";

/** Bridges Kumo's Link / LinkButton / Breadcrumbs.Link to Next.js client-side routing — Kumo's
 *  documented LinkProvider recipe. Without it Kumo renders a plain <a>, which full-reloads the
 *  document; a reload drops the in-memory vault session and re-locks the app. */
export const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(function AppLink(
  { href, to, ...rest },
  ref,
) {
  return <NextLink ref={ref} href={href ?? to ?? ""} {...rest} />;
});
