const isBackendUnreachableResponse = (response, requestUrl) => {
  const status = Number(response?.status);
  if (status === 502 || status === 503 || status === 504) {
    return true;
  }

  const url = typeof requestUrl === 'string' ? requestUrl : '';
  const isConnectivityProbe = url === '/api/llm/status' || url === '/api/projects';

  // When running the frontend dev server, a missing backend can present as a 404
  // (because the proxy cannot reach the upstream). Treat that as "offline" for
  // critical probe endpoints.
  if (isConnectivityProbe && status === 404) {
    return true;
  }

  return false;
};

export { isBackendUnreachableResponse };
