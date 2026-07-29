/*
 * Copyright (c) 2000-2020 by Rodney Kinney, Joel Uckelman
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Library General Public
 * License (LGPL) as published by the Free Software Foundation.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Library General Public License for more details.
 *
 * You should have received a copy of the GNU Library General Public
 * License along with this library; if not, copies are available
 * at http://www.opensource.org.
 */

/*
 * ---------------------------------------------------------------------------
 * vassal-webswing PATCH, against VASSAL 3.7.24's VASSAL/launch/Player.java.
 *
 * Adds one thing: after the module is up, take the seat the portal prepared.
 *
 * Why a patch is needed at all. The portal can point a player's preferences at
 * the right server and fill in their name and password, but stock VASSAL will
 * not connect by itself — the only setConnected(true) that fires without a
 * human is behind the welcome wizard's "Play Online" radio — and it always
 * joins "Main Room", which cannot host a game: NodeClient.setRoom() calls
 * getGameState().setup(false) for the default room and only requests a state
 * synchronisation for named rooms. setDefaultRoomName() exists but has no
 * callers in 3.7.24. So without this, every player had to press Connect and
 * then create or find their room by hand.
 *
 * Everything here goes through the public ChatServerConnection interface; no
 * VASSAL internals are touched, which keeps the patch small enough to re-apply
 * on a VASSAL upgrade. Re-check it whenever VASSAL is bumped.
 * ---------------------------------------------------------------------------
 */
package VASSAL.launch;

import java.awt.event.ActionEvent;
import java.beans.PropertyChangeListener;
import java.io.File;
import java.io.IOException;

import javax.swing.JFrame;
import javax.swing.JMenuBar;
import javax.swing.SwingUtilities;
import javax.swing.SwingWorker;

import org.apache.commons.lang3.SystemUtils;

import VASSAL.Info;
import VASSAL.build.GameModule;
import VASSAL.build.module.ExtensionsLoader;
import VASSAL.build.module.ModuleExtension;
import VASSAL.build.module.WizardSupport;
import VASSAL.build.module.metadata.AbstractMetaData;
import VASSAL.build.module.metadata.MetaDataFactory;
import VASSAL.build.module.metadata.ModuleMetaData;
import VASSAL.build.module.ServerConnection;
import VASSAL.chat.ChatServerConnection;
import VASSAL.chat.Room;
import VASSAL.chat.SimpleRoom;
import VASSAL.i18n.Localization;
import VASSAL.i18n.Resources;
import VASSAL.preferences.Prefs;
import VASSAL.tools.DataArchive;
import VASSAL.tools.ErrorDialog;
import VASSAL.tools.JarArchive;
import VASSAL.tools.UsernameAndPasswordDialog;
import VASSAL.tools.menu.MacOSXMenuManager;
import VASSAL.tools.menu.MenuBarProxy;
import VASSAL.tools.menu.MenuManager;

/**
 * @author Joel Uckelman
 * @since 3.1.0
 */
public class Player extends Launcher {
  public static void main(String[] args) throws IOException {
    Info.setConfig(new StandardConfig());
    new Player(args);
  }

  protected Player(String[] args) {
    // the ctor is protected to enforce that it's called via main()
    super(args);
  }

  @Override
  protected MenuManager createMenuManager() {
    return SystemUtils.IS_OS_MAC ?
      new MacOSXMenuManager() : new PlayerMenuManager();
  }

  @Override
  protected void launch() throws IOException {
    if (lr.builtInModule) {
      GameModule.init(createModule(createDataArchive()));

      if (lr.autoext != null) {
        for (final String ext : lr.autoext) {
          createExtension(ext).build();
        }
      }

      createExtensionsLoader().addTo(GameModule.getGameModule());
      Localization.getInstance().translate();
      showWizardOrPlayerWindow(GameModule.getGameModule());
    }
    else {
      GameModule.init(createModule(createDataArchive()));
      createExtensionsLoader().addTo(GameModule.getGameModule());
      Localization.getInstance().translate();
      final GameModule m = GameModule.getGameModule();
      if (lr.game != null) {
        m.getPlayerWindow().setVisible(true);
        m.setGameFile(lr.game.getName(), GameModule.GameFileMode.LOADED_GAME);
        m.getGameState().loadGameInBackground(lr.game);
      }
      else {
        showWizardOrPlayerWindow(m);
      }
    }
  }

  protected ExtensionsLoader createExtensionsLoader() {
    return new ExtensionsLoader();
  }

  protected ModuleExtension createExtension(String name) {
    return new ModuleExtension(new JarArchive(name));
  }

  protected DataArchive createDataArchive() throws IOException {
    if (lr.builtInModule) {
      return new JarArchive();
    }
    else {
      return new DataArchive(lr.module.getPath());
    }
  }

  protected GameModule createModule(DataArchive archive) {
    return new GameModule(archive);
  }

  private void showWizardOrPlayerWindow(GameModule module) {
    module.getPlayerWindow().setVisible(true);

    final Boolean showWizard = (Boolean) Prefs.getGlobalPrefs().getValue(WizardSupport.WELCOME_WIZARD_KEY);
    if (Boolean.TRUE.equals(showWizard)) {
      module.getWizardSupport().showWelcomeWizard();
    }
    else {
      // prompt for username and password if wizard is off
      // but no username is set
      if (!module.isRealName()) {
        new UsernameAndPasswordDialog(module.getPlayerWindow()).setVisible(true);
      }
    }

    autoSeat(module);
  }

  /**
   * Preference holding the room the portal seated this player at.
   *
   * Stored in the MODULE's preferences, not the global ones. A player may have
   * several games open at once — the portal caps it, it does not forbid it —
   * and one global slot means opening the second game rewrites where the first
   * one would reconnect to. Observed on 2026-07-28: two tables opened before
   * either was launched, and both JVMs joined the room named for the second.
   */
  private static final String PORTAL_ROOM_PREF = "PortalRoom"; //NON-NLS

  /** How long to wait for the room list before giving up and creating the room. */
  private static final int ROOM_WAIT_MS = 8000;
  private static final int ROOM_POLL_MS = 250;

  /**
   * vassal-webswing patch: connect and join the room the portal chose.
   *
   * Does nothing at all unless the portal wrote {@code PortalRoom}, so a module
   * opened directly still behaves exactly like stock VASSAL.
   *
   * Joining is deliberately done by looking the room up in the server's own
   * list first: {@code NodeClient.setRoom} only requests a game-state
   * synchronisation when handed a real room object it does not own. Passing a
   * freshly built {@link SimpleRoom} is right for whoever opens the table (they
   * own it and have nothing to synchronise) and wrong for everyone after them,
   * who would silently arrive at an empty board.
   */
  private void autoSeat(GameModule module) {
    final String room = module.getPrefs().getStoredValue(PORTAL_ROOM_PREF);
    if (room == null || room.trim().isEmpty()) {
      return;
    }

    final ChatServerConnection client = module.getServerControls().getClient();
    if (client == null) {
      return;
    }

    final boolean[] seated = {false};
    final PropertyChangeListener onConnect = evt -> {
      if (!Boolean.TRUE.equals(evt.getNewValue()) || seated[0]) {
        return;
      }
      seated[0] = true;
      new SwingWorker<Room, Void>() {
        @Override
        protected Room doInBackground() throws Exception {
          // Wait for the room list so an existing table is joined as itself.
          for (int waited = 0; waited < ROOM_WAIT_MS; waited += ROOM_POLL_MS) {
            for (final Room r : client.getAvailableRooms()) {
              if (room.equals(r.getName())) {
                return r;
              }
            }
            Thread.sleep(ROOM_POLL_MS);
          }
          // Not there: we are the first to arrive, so create it.
          return new SimpleRoom(room);
        }

        @Override
        protected void done() {
          try {
            client.setRoom(get());
          }
          catch (Exception e) {
            ErrorDialog.bug(e);
          }
        }
      }.execute();
    };

    client.addPropertyChangeListener(ServerConnection.CONNECTED, onConnect);
    SwingUtilities.invokeLater(() -> client.setConnected(true));
  }

  public static class LaunchAction extends AbstractLaunchAction {
    private static final long serialVersionUID = 1L;

    public LaunchAction(ModuleManagerWindow mm, File module) {
      super(Resources.getString("Main.play_module_specific"), mm,
        Player.class.getName(),
        new LaunchRequest(LaunchRequest.Mode.LOAD, module)
      );
      setEnabled(!isEditing(module));
    }

    public LaunchAction(ModuleManagerWindow mm, File module, File saveGame) {
      super(Resources.getString("General.open"), mm, Player.class.getName(),
        new LaunchRequest(LaunchRequest.Mode.LOAD, module, saveGame)
      );
      setEnabled(!isEditing(module));
    }

    @Override
    public void actionPerformed(ActionEvent e) {
      if (isEditing(lr.module)) return;

      // don't permit loading of VASL saved before 3.4
      final AbstractMetaData data = MetaDataFactory.buildMetaData(lr.module);
      if (data instanceof ModuleMetaData) {
        if (!checkModuleLoadable((ModuleMetaData)data)) {
          return;
        }
      }
      else {
        if (lr.module != null) {
          // A module in the MM should be a valid Module, but people can and do delete
          // or replace module files while the MM is running.
          ErrorDialog.show("Error.invalid_vassal_module", lr.module.getAbsolutePath()); //NON-NLS
          lr.module = null;
        }
        return;
      }

      // increase the using count
      incrementUsed(lr.module);
      super.actionPerformed(e);
    }

    @Override
    protected LaunchTask getLaunchTask() {
      return new LaunchTask() {
        @Override
        protected void done() {
          super.done();

          // reduce the using count
          decrementUsed(lr.module);
        }
      };
    }
  }

  public static class PromptLaunchAction extends LaunchAction {
    private static final long serialVersionUID = 1L;

    public PromptLaunchAction(ModuleManagerWindow mm) {
      super(mm, null);
      putValue(NAME, Resources.getString("Main.play_module"));
    }

    @Override
    public void actionPerformed(ActionEvent e) {
      // prompt the user to pick a module
      if (promptForFile() == null) return;

      final AbstractMetaData data = MetaDataFactory.buildMetaData(lr.module);
      if (data != null && Info.isModuleTooNew(data.getVassalVersion())) {
        ErrorDialog.show(
          "Error.module_too_new", //NON-NLS
          lr.module.getPath(),
          data.getVassalVersion(),
          Info.getVersion()
        );
        return;
      }

      super.actionPerformed(e);
    }
  }

  private static class PlayerMenuManager extends MenuManager {
    private final MenuBarProxy menuBar = new MenuBarProxy();

    @Override
    public JMenuBar getMenuBarFor(JFrame fc) {
      return (fc instanceof PlayerWindow) ? menuBar.createPeer() : null;
    }

    @Override
    public MenuBarProxy getMenuBarProxyFor(JFrame fc) {
      return (fc instanceof PlayerWindow) ? menuBar : null;
    }
  }
}
