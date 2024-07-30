import { type NextFetchEvent, NextRequest, NextResponse } from 'next/server';
import { pathToRegexp } from 'path-to-regexp';

export type NextMiddleware = (
  request: NextRequest,
  event: NextFetchEvent,
) => Response | NextResponse | Promise<Response | NextResponse>;

export type MiddlewareFunction = (
  request: NextRequest,
  response: NextResponse | Response | null,
  event: NextFetchEvent,
) => NextResponse | Response | Promise<NextResponse | Response>;

export type MiddlewareConfig = Record<string, MiddlewareFunction>;

export function createMiddleware(
  pathMiddlewareMap: MiddlewareConfig,
  globalMiddleware?: Record<string, MiddlewareFunction>,
): NextMiddleware {
  return async (
    request: NextRequest,
    event: NextFetchEvent,
  ): Promise<NextResponse | Response> => {
    const path = request.nextUrl.pathname || '/';
    let response: NextResponse | Response | null = null;

    const beforeResult = await executeGlobalMiddleware(
      'before',
      request,
      event,
      globalMiddleware,
    );
    if (beforeResult) {
      return handleMiddlewareRedirect(request, beforeResult);
    }

    for (const [key, middlewareFunctions] of Object.entries(
      pathMiddlewareMap,
    )) {
      if (matchesPath(key, path)) {
        response = await executePathMiddleware(
          request,
          middlewareFunctions,
          response,
          event,
        );
      }
    }

    const afterResult = await executeGlobalMiddleware(
      'after',
      request,
      event,
      globalMiddleware,
    );
    if (afterResult) {
      return handleMiddlewareRedirect(request, afterResult);
    }

    return response ?? NextResponse.next();
  };
}

async function executePathMiddleware(
  request: NextRequest,
  middlewareFunctions: MiddlewareFunction | MiddlewareFunction[],
  initialResponse: NextResponse | Response | null,
  event: NextFetchEvent,
): Promise<NextResponse | Response | null> {
  if (!Array.isArray(middlewareFunctions)) {
    // eslint-disable-next-line no-param-reassign -- need to update function signature
    middlewareFunctions = [middlewareFunctions];
  }

  const response = initialResponse;

  for (const middleware of middlewareFunctions) {
    const result = await executeMiddleware(
      request,
      middleware,
      response,
      event,
    );
    if (result) {
      // eslint-disable-next-line no-param-reassign -- need to update function signature
      request = updateRequestWithResponse(request, result);
    }
  }

  return response;
}

async function executeMiddleware(
  request: NextRequest,
  middleware: MiddlewareFunction,
  currentResponse: NextResponse | Response | null,
  event: NextFetchEvent,
): Promise<NextResponse | Response | null> {
  const result = await middleware(request, currentResponse, event);

  if (currentResponse) {
    currentResponse.headers.forEach((value, key) => {
      result.headers.set(key, value);
    });
  }

  if (isRedirect(result) || result.status >= 400) {
    return result;
  }

  return result;
}

async function executeGlobalMiddleware(
  type: 'before' | 'after',
  request: NextRequest,
  event: NextFetchEvent,
  globalMiddleware?: Record<string, MiddlewareFunction>,
): Promise<NextResponse | Response | null> {
  const globalMiddlewareFn = globalMiddleware?.[type];
  if (globalMiddlewareFn) {
    const result = await executeMiddleware(
      request,
      globalMiddlewareFn,
      null,
      event,
    );
    if (result && isRedirect(result)) {
      request.headers.set(
        'x-redirect-url',
        result.headers.get('location') ?? '',
      );
      if (result instanceof NextResponse) {
        result.cookies.getAll().forEach((cookie) => {
          request.cookies.set(cookie);
        });
      }
      return result;
    }
  }
  return null;
}

function matchesPath(pattern: string, path: string): boolean {
  return pathToRegexp(pattern).test(path);
}

function handleMiddlewareRedirect(
  request: NextRequest,
  response: NextResponse | Response,
): NextResponse | Response {
  const redirectUrl = request.headers.get('x-redirect-url');

  if (redirectUrl) {
    const redirectResponse = NextResponse.redirect(redirectUrl, {
      headers: request.headers, // Transfer original headers to the redirect response
    });

    // Copy cookies from the original request to the redirect response
    request.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie);
    });

    return redirectResponse;
  }

  return response;
}

function isRedirect(response: NextResponse | Response | null): boolean {
  return Boolean(
    response && [301, 302, 303, 307, 308].includes(response.status),
  );
}

function updateRequestWithResponse(
  request: NextRequest,
  response: NextResponse | Response,
): NextRequest {
  const updatedHeaders = new Headers(request.headers);

  // Merge headers from the response into the request headers
  response.headers.forEach((value, key) => {
    updatedHeaders.set(key, value);
  });

  // Create a new URL object with the same parameters as the original request
  const updatedUrl = new URL(request.url);

  // Create a new NextRequest object with the updated headers
  const updatedRequest = new NextRequest(updatedUrl, {
    headers: updatedHeaders,
    method: request.method,
    body: request.body,
    referrer: request.referrer,
  });

  // Merge cookies from the response into the request cookies
  if (response instanceof NextResponse) {
    response.cookies.getAll().forEach((cookie) => {
      updatedRequest.cookies.set(cookie.name, cookie.value);
    });
  }

  return updatedRequest;
}
