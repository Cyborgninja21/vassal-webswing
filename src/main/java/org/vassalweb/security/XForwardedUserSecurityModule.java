package org.vassalweb.security;

import java.io.IOException;

import javax.servlet.ServletException;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.webswing.server.common.service.security.AuthenticatedWebswingUser;
import org.webswing.server.services.security.api.WebswingAuthenticationException;
import org.webswing.server.services.security.api.WebswingSecurityModuleConfig;
import org.webswing.server.services.security.modules.AbstractSecurityModule;

/**
 * Header-trust security module for deployments where authentication happens at a
 * reverse proxy (Traefik + Authentik forward-auth). The proxy injects the
 * authenticated username as a request header; this module accepts it as the
 * Webswing identity. There is no login page — an unauthenticated request can only
 * mean the request bypassed the proxy, and is refused.
 *
 * <p>Environment configuration (compose-friendly):
 * <ul>
 *   <li>{@code WEBSWING_AUTH_HEADER} — header carrying the username
 *       (default {@code X-authentik-username}).</li>
 *   <li>{@code WEBSWING_EDGE_SECRET} — optional shared secret. When set, requests
 *       must also carry {@code X-Webswing-Edge-Secret} with the same value
 *       (injected by a proxy headers middleware); anything else is refused even
 *       if a username header is present. Defense in depth against a container on
 *       the same network spoofing the username header.</li>
 * </ul>
 *
 * <p>The username keys {@code CONTINUE_FOR_USER} reconnects and the
 * {@code ${user}} substitution for per-player home and transfer dirs.
 */
public class XForwardedUserSecurityModule
    extends AbstractSecurityModule<WebswingSecurityModuleConfig> {

  private static final Logger log = LoggerFactory.getLogger(XForwardedUserSecurityModule.class);

  public static final String DEFAULT_USER_HEADER = "X-authentik-username";
  public static final String EDGE_SECRET_HEADER = "X-Webswing-Edge-Secret";

  private final String userHeader;
  private final String edgeSecret;

  public XForwardedUserSecurityModule(WebswingSecurityModuleConfig config) {
    super(config);
    String header = System.getenv("WEBSWING_AUTH_HEADER");
    this.userHeader = (header == null || header.isBlank()) ? DEFAULT_USER_HEADER : header.trim();
    String secret = System.getenv("WEBSWING_EDGE_SECRET");
    this.edgeSecret = (secret == null || secret.isBlank()) ? null : secret;
    log.info("XForwardedUser realm active: user header [{}], edge secret {}", userHeader,
        edgeSecret == null ? "DISABLED" : "required");
  }

  @Override
  protected AuthenticatedWebswingUser authenticate(HttpServletRequest request)
      throws WebswingAuthenticationException {
    if (edgeSecret != null && !constantTimeEquals(edgeSecret, request.getHeader(EDGE_SECRET_HEADER))) {
      logFailure(request, null, "edge secret missing or mismatched");
      throw new WebswingAuthenticationException(
          "Request did not arrive through the authenticating proxy.");
    }
    String user = sanitize(request.getHeader(userHeader));
    if (user == null) {
      logFailure(request, null, "no " + userHeader + " header");
      throw new WebswingAuthenticationException(
          "Not authenticated. Access this application through its public URL.");
    }
    logSuccess(request, user);
    return new XForwardedWebswingUser(user);
  }

  /** Restrict to a filesystem/lobby-safe identifier: ${user} feeds home and transfer paths. */
  private static String sanitize(String raw) {
    if (raw == null) {
      return null;
    }
    String v = raw.trim();
    if (v.isEmpty() || v.length() > 64 || !v.matches("[A-Za-z0-9](?:[A-Za-z0-9._@-]*[A-Za-z0-9])?")) {
      return null;
    }
    return v;
  }

  private static boolean constantTimeEquals(String expected, String actual) {
    if (actual == null) {
      return false;
    }
    byte[] a = expected.getBytes(java.nio.charset.StandardCharsets.UTF_8);
    byte[] b = actual.getBytes(java.nio.charset.StandardCharsets.UTF_8);
    return java.security.MessageDigest.isEqual(a, b);
  }

  @Override
  protected void serveLoginPage(HttpServletRequest request, HttpServletResponse response,
      WebswingAuthenticationException exception) throws IOException {
    refuse(response, exception);
  }

  @Override
  protected void serveLoginPartial(HttpServletRequest request, HttpServletResponse response,
      WebswingAuthenticationException exception) throws IOException {
    refuse(response, exception);
  }

  private void refuse(HttpServletResponse response, WebswingAuthenticationException exception)
      throws IOException {
    response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
    response.setContentType("text/html;charset=UTF-8");
    response.getWriter().write("<h1>401</h1><p>"
        + (exception == null ? "Not authenticated." : exception.getMessage()) + "</p>");
  }

  @Override
  public void doLogout(HttpServletRequest request, HttpServletResponse response)
      throws ServletException, IOException {
    sendPartialHtml(request, response, "logoutPartial.html", null);
  }
}
