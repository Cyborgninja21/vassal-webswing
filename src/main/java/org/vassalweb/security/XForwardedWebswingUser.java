package org.vassalweb.security;

import java.io.Serializable;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import org.webswing.server.common.model.security.WebswingAction;
import org.webswing.server.common.service.security.AuthenticatedWebswingUser;

/** Webswing identity backed by the proxy-supplied username. */
public class XForwardedWebswingUser extends AuthenticatedWebswingUser {

  private static final long serialVersionUID = 1L;

  private final String userId;
  private final List<String> roles = List.of(WebswingAction.AccessType.basic.name());

  public XForwardedWebswingUser(String userId) {
    this.userId = userId;
  }

  @Override
  public String getUserId() {
    return userId;
  }

  @Override
  public List<String> getUserRoles() {
    return roles;
  }

  @Override
  public Map<String, Serializable> getUserAttributes() {
    return Collections.emptyMap();
  }

  @Override
  public Map<String, Serializable> getUserSessionAttributes() {
    return Collections.emptyMap();
  }

  @Override
  public boolean hasRole(String role) {
    return roles.contains(role);
  }

  public boolean isAuthenticated() {
    return true;
  }
}
