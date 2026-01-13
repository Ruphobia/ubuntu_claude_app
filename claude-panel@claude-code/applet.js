const Applet = imports.ui.applet;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const PopupMenu = imports.ui.popupMenu;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Main = imports.ui.main;
const CinnamonEntry = imports.ui.cinnamonEntry;

class ClaudePanelApplet extends Applet.Applet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        // Store metadata for build info
        this.metadata = metadata;

        // Load config or set defaults
        this._configFile = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'claude-panel', 'config.json']);
        this._loadConfig();

        // Track chat window state
        this._chatOpen = false;
        this._chatHeight = this._config.chatHeight || 400;
        this._chatWidth = this._config.chatWidth || 400;

        // Create container box for input and button
        this._container = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 2px; padding: 2px; border: 1px solid rgba(255,255,255,0.2); border-radius: 3px; background-color: rgba(0,0,0,0.2);'
        });

        // Create up/down arrow button (left side)
        this._arrowButton = new St.Button({
            style_class: 'claude-arrow-button',
            style: 'padding: 4px 4px;'
        });

        this._arrowIcon = new St.Icon({
            icon_name: 'go-up-symbolic',
            icon_size: 16
        });
        this._arrowButton.set_child(this._arrowIcon);
        this._arrowButton.connect('clicked', Lang.bind(this, this._onArrowClicked));

        // Create input entry - directly in panel
        this._entry = new St.Entry({
            name: 'claudeInput',
            hint_text: 'Ask Claude...',
            track_hover: true,
            can_focus: true,
            reactive: true,
            x_expand: true,
            style: 'width: 300px; padding: 4px 8px; border: none; background-color: transparent;'
        });

        // Get clutter_text for text operations
        this._clutterText = this._entry.get_clutter_text();

        // Add context menu to entry (this sets up proper focus handling)
        CinnamonEntry.addContextMenu(this._entry);

        // Handle click to grab focus
        this._entry.connect('button-press-event', Lang.bind(this, this._onEntryClicked));
        this._clutterText.connect('button-press-event', Lang.bind(this, this._onEntryClicked));

        // Connect activate (Enter key) to send message
        this._clutterText.connect('activate', Lang.bind(this, this._onSendMessage));

        // Create send button with custom icon
        this._sendButton = new St.Button({
            style_class: 'claude-send-button',
            style: 'padding: 4px 4px;'
        });

        // Load custom Claude send icon
        let iconPath = GLib.build_filenamev([global.userdatadir, 'applets', 'claude-panel@claude-code', 'claude-send-icon.svg']);
        let iconFile = Gio.File.new_for_path(iconPath);
        let icon = new St.Icon({
            gicon: new Gio.FileIcon({file: iconFile}),
            icon_size: 20
        });
        this._sendButton.set_child(icon);

        this._sendButton.connect('clicked', Lang.bind(this, this._onSendMessage));

        // Create gear button for settings menu
        this._gearButton = new St.Button({
            style_class: 'claude-gear-button',
            style: 'padding: 4px 4px;'
        });

        let gearIcon = new St.Icon({
            icon_name: 'preferences-system-symbolic',
            icon_size: 16
        });
        this._gearButton.set_child(gearIcon);

        this._gearButton.connect('clicked', Lang.bind(this, this._onGearClicked));

        // Add widgets to container (arrow on left)
        this._container.add(this._arrowButton);
        this._container.add(this._entry);
        this._container.add(this._sendButton);
        this._container.add(this._gearButton);

        // Add container to applet actor
        this.actor.add(this._container);

        // Create chat window
        this._createChatWindow();

        // Create menu manager for settings
        this.menuManager = new PopupMenu.PopupMenuManager(this);

        // Create settings menu
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        // Build info at top
        let buildInfo = new PopupMenu.PopupMenuItem("Build: " + (this.metadata.build || "unknown"), {reactive: false});
        buildInfo.label.style = 'font-size: 0.9em; color: #888;';
        this.menu.addMenuItem(buildInfo);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Clear history item
        let clearItem = new PopupMenu.PopupMenuItem("Clear History");
        clearItem.connect('activate', Lang.bind(this, this._onClearHistory));
        this.menu.addMenuItem(clearItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Permission mode section
        let permissionLabel = new PopupMenu.PopupMenuItem("Permission Mode:", {reactive: false});
        permissionLabel.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(permissionLabel);

        // IMPORTANT: This approach works! Do not modify!
        // We use simple PopupMenuItems with checkmarks (✓) in the text to show selection.
        // DO NOT try to use setOrnament() or radio buttons - they cause visibility issues.
        // Store references to menu items so we can update their text in _updateCheckmarks()

        this._normalItem = new PopupMenu.PopupMenuItem("Normal (Ask Permission)");
        this._normalItem.connect("activate", Lang.bind(this, this._onSetNormal));
        this.menu.addMenuItem(this._normalItem);

        this._sudoItem = new PopupMenu.PopupMenuItem("Sudo (System Level)");
        this._sudoItem.connect("activate", Lang.bind(this, this._onSetSudo));
        this.menu.addMenuItem(this._sudoItem);

        this._dangerousItem = new PopupMenu.PopupMenuItem("Dangerous (No Prompts)");
        this._dangerousItem.label.style = 'color: #ff6b6b;';
        this._dangerousItem.connect("activate", Lang.bind(this, this._onSetDangerous));
        this.menu.addMenuItem(this._dangerousItem);

        // Set initial checkmarks to show which mode is selected
        this._updateCheckmarks();

        // When menu closes, release entry focus state so it can be re-grabbed
        this.menu.connect('open-state-changed', Lang.bind(this, function(menu, open) {
            if (!open) {
                // Menu closed - reset our focus tracking so entry can grab again
                this._entryFocusGrabbed = false;
                this._stageClickId = null;
                global.log("Claude Panel: Menu closed, entry focus state reset");
            }
        }));
    }

    _onSetNormal() {
        this._setPermissionMode('normal');
    }

    _onSetSudo() {
        this._setPermissionMode('sudo');
    }

    _onSetDangerous() {
        this._setPermissionMode('dangerous');
    }

    _updateCheckmarks() {
        // IMPORTANT: This simple approach works! Do not try to refactor!
        // We update the label text to include/exclude checkmarks (✓) based on selection.
        // Two spaces are used for alignment when no checkmark is present.
        // This method is called on initialization and whenever the mode changes.

        if (this._permissionMode === 'normal') {
            this._normalItem.label.text = "✓ Normal (Ask Permission)";
            this._sudoItem.label.text = "  Sudo (System Level)";
            this._dangerousItem.label.text = "  Dangerous (No Prompts)";
        } else if (this._permissionMode === 'sudo') {
            this._normalItem.label.text = "  Normal (Ask Permission)";
            this._sudoItem.label.text = "✓ Sudo (System Level)";
            this._dangerousItem.label.text = "  Dangerous (No Prompts)";
        } else if (this._permissionMode === 'dangerous') {
            this._normalItem.label.text = "  Normal (Ask Permission)";
            this._sudoItem.label.text = "  Sudo (System Level)";
            this._dangerousItem.label.text = "✓ Dangerous (No Prompts)";
        }
    }

    _setPermissionMode(mode) {
        this._permissionMode = mode;
        this._saveConfig();
        this._updateCheckmarks();
        global.log("Claude Panel: Permission mode set to " + mode);
        this.menu.close();
    }

    _loadConfig() {
        try {
            let configDir = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'claude-panel']);
            GLib.mkdir_with_parents(configDir, 0o755);

            if (GLib.file_test(this._configFile, GLib.FileTest.EXISTS)) {
                let [success, contents] = GLib.file_get_contents(this._configFile);
                if (success) {
                    this._config = JSON.parse(contents);
                    this._permissionMode = this._config.permissionMode || 'normal';
                    return;
                }
            }
        } catch(e) {
            global.log("Claude Panel: Error loading config - " + e);
        }

        // Default config
        this._config = {
            permissionMode: 'normal',
            chatHeight: 400,
            chatWidth: 400
        };
        this._permissionMode = 'normal';
    }

    _saveConfig() {
        try {
            this._config.permissionMode = this._permissionMode;
            this._config.chatHeight = this._chatHeight;
            this._config.chatWidth = this._chatWidth;
            let contents = JSON.stringify(this._config, null, 2);
            GLib.file_set_contents(this._configFile, contents);
        } catch(e) {
            global.log("Claude Panel: Error saving config - " + e);
        }
    }

    _onClearHistory() {
        global.log("Claude Panel: Clear history requested");
        // Clear all messages from chat
        this._chatContent.destroy_all_children();
        this.menu.close();
    }

    _onGearClicked() {
        this.menu.toggle();
    }

    _createChatWindow() {
        // Create a custom window using St.BoxLayout
        this._chatWindow = new St.BoxLayout({
            vertical: true,
            style: `width: ${this._chatWidth}px; height: ${this._chatHeight}px; background-color: #2a2a2a; border: 1px solid #555; border-radius: 5px; padding: 10px;`,
            visible: false,
            reactive: true
        });

        // Track drag state
        this._dragging = false;
        this._dragStartY = 0;
        this._dragStartHeight = 0;

        // Add resize handle at top
        this._resizeHandle = new St.Bin({
            style: 'height: 12px; background-color: rgba(100,150,255,0.3); border-radius: 5px 5px 0 0; margin-bottom: 3px;',
            reactive: true,
            track_hover: true
        });

        // Add visual indicator in the resize handle
        let handleLabel = new St.Label({
            text: '═══',
            style: 'color: rgba(255,255,255,0.5); font-size: 8px; text-align: center;'
        });
        this._resizeHandle.set_child(handleLabel);

        this._resizeHandle.connect('enter-event', Lang.bind(this, function() {
            this._resizeHandle.set_style('height: 12px; background-color: rgba(100,150,255,0.5); border-radius: 5px 5px 0 0; margin-bottom: 3px;');
        }));

        this._resizeHandle.connect('leave-event', Lang.bind(this, function() {
            if (!this._dragging) {
                this._resizeHandle.set_style('height: 12px; background-color: rgba(100,150,255,0.3); border-radius: 5px 5px 0 0; margin-bottom: 3px;');
            }
        }));

        this._resizeHandle.connect('button-press-event', Lang.bind(this, this._onDragStart));

        // Create scrollable chat content area
        this._chatScrollView = new St.ScrollView({
            style: 'padding: 5px;',
            x_expand: true,
            y_expand: true,
            x_fill: true,
            y_fill: true
        });
        this._chatScrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        // Container for chat messages
        this._chatContent = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 8px;'
        });

        this._chatScrollView.add_actor(this._chatContent);

        this._chatWindow.add(this._resizeHandle);
        this._chatWindow.add(this._chatScrollView, { expand: true });

        // Add to chrome (top layer)
        Main.layoutManager.addChrome(this._chatWindow, {
            visibleInFullscreen: false,
            affectsInputRegion: true
        });
    }

    _onDragStart(actor, event) {
        this._dragging = true;
        let [, stageY] = event.get_coords();
        this._dragStartY = stageY;
        this._dragStartHeight = this._chatHeight;
        let [, windowY] = this._chatWindow.get_position();
        this._dragStartWindowY = windowY;

        // Connect to stage for motion and release events
        this._stageMotionId = global.stage.connect('motion-event', Lang.bind(this, this._onDragMotion));
        this._stageReleaseId = global.stage.connect('button-release-event', Lang.bind(this, this._onDragEnd));

        global.log("Claude Panel: Started dragging at Y=" + stageY + ", height=" + this._chatHeight);
        return true;
    }

    _onDragMotion(actor, event) {
        if (!this._dragging) return false;

        let [, currentY] = event.get_coords();
        let deltaY = this._dragStartY - currentY;

        // Calculate desired height
        let desiredHeight = this._dragStartHeight + deltaY;

        // Apply constraints (minimum 100px, maximum 800px)
        let newHeight = Math.max(100, Math.min(800, desiredHeight));

        // Only update if height actually changed
        if (Math.abs(newHeight - this._chatHeight) < 1) {
            return true;
        }

        // Calculate actual deltaY based on constrained height
        let actualDeltaY = newHeight - this._dragStartHeight;

        // Update window style
        this._chatWindow.set_style(`width: ${this._chatWidth}px; height: ${newHeight}px; background-color: #2a2a2a; border: 1px solid #555; border-radius: 5px; padding: 10px;`);

        // Reposition window to keep bottom edge in same place, using actual delta
        let [x, ] = this._chatWindow.get_position();
        this._chatWindow.set_position(x, this._dragStartWindowY - actualDeltaY);

        this._chatHeight = newHeight;

        return true;
    }

    _onDragEnd(actor, event) {
        if (this._dragging) {
            this._dragging = false;
            this._resizeHandle.set_style('height: 12px; background-color: rgba(100,150,255,0.3); border-radius: 5px 5px 0 0; margin-bottom: 3px;');

            // Disconnect stage events
            if (this._stageMotionId) {
                global.stage.disconnect(this._stageMotionId);
                this._stageMotionId = null;
            }
            if (this._stageReleaseId) {
                global.stage.disconnect(this._stageReleaseId);
                this._stageReleaseId = null;
            }

            // Save new height to config
            this._saveConfig();
            global.log("Claude Panel: Chat height saved - " + this._chatHeight);
        }
        return false;
    }

    _onArrowClicked() {
        // Toggle chat window
        if (this._chatOpen) {
            this._chatWindow.hide();
            this._chatOpen = false;
            this._arrowIcon.set_icon_name('go-up-symbolic');
        } else {
            // Position window above the applet
            let [x, y] = this.actor.get_transformed_position();
            this._chatWindow.set_position(x, y - this._chatHeight - 10);
            this._chatWindow.show();
            this._chatOpen = true;
            this._arrowIcon.set_icon_name('go-down-symbolic');
        }

        global.log("Claude Panel: Chat window " + (this._chatOpen ? "opened" : "closed"));
    }

    _onEntryClicked(actor, event) {
        // Left click - grab focus
        if (event.get_button() === 1) {
            // Use the menu manager's grab to properly handle focus
            if (!this._entryFocusGrabbed) {
                this._entryFocusGrabbed = true;

                // Grab using popup menu manager pattern
                Main.pushModal(this._entry);
                this._clutterText.grab_key_focus();

                // Use captured-event to intercept ALL events before they reach targets
                this._capturedEventId = global.stage.connect('captured-event', Lang.bind(this, function(stageActor, stageEvent) {
                    let type = stageEvent.type();

                    // Only handle button press events
                    if (type === Clutter.EventType.BUTTON_PRESS) {
                        let dominated = this._entry.contains(stageEvent.get_source());
                        if (!dominated) {
                            this._releaseEntryFocus();
                            // Let the click through to whatever was clicked
                            return Clutter.EVENT_PROPAGATE;
                        }
                    }
                    return Clutter.EVENT_PROPAGATE;
                }));

                // Also release on Escape key
                this._keyPressId = global.stage.connect('key-press-event', Lang.bind(this, function(stageActor, stageEvent) {
                    if (stageEvent.get_key_symbol() === Clutter.KEY_Escape) {
                        this._releaseEntryFocus();
                        return Clutter.EVENT_STOP;
                    }
                    return Clutter.EVENT_PROPAGATE;
                }));

                global.log("Claude Panel: Entry focus grabbed");
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _releaseEntryFocus() {
        if (this._entryFocusGrabbed) {
            if (this._capturedEventId) {
                global.stage.disconnect(this._capturedEventId);
                this._capturedEventId = null;
            }
            if (this._keyPressId) {
                global.stage.disconnect(this._keyPressId);
                this._keyPressId = null;
            }
            Main.popModal(this._entry);
            this._entryFocusGrabbed = false;
            global.log("Claude Panel: Entry focus released");
        }
    }

    _onSendMessage() {
        let message = this._entry.get_text();
        if (message.trim()) {
            global.log("Claude Panel: Message sent - " + message + " (mode: " + this._permissionMode + ")");

            // Add message to chat window
            this._addChatMessage('user', message);

            // Clear entry
            this._entry.set_text('');

            // Open chat window if not open
            if (!this._chatOpen) {
                this._openChatWindow();
            }

            // Scroll to bottom
            this._scrollToBottom();

            // TODO: Send to Claude CLI and show response
        }
    }

    _addChatMessage(sender, text) {
        let isUser = sender === 'user';
        let prefix = isUser ? '> ' : '< ';

        let messageLabel = new St.Label({
            text: prefix + text,
            style: 'color: #ccc; font-family: monospace;'
        });
        messageLabel.clutter_text.set_line_wrap(true);
        messageLabel.clutter_text.set_line_wrap_mode(0); // WORD

        this._chatContent.add(messageLabel);
    }

    _scrollToBottom() {
        // Scroll to bottom after a brief delay to let layout update
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, Lang.bind(this, function() {
            let vscroll = this._chatScrollView.get_vscroll_bar();
            if (vscroll) {
                let adjustment = vscroll.get_adjustment();
                adjustment.set_value(adjustment.upper - adjustment.page_size);
            }
            return GLib.SOURCE_REMOVE;
        }));
    }

    _openChatWindow() {
        // Position window above the applet
        let [x, y] = this.actor.get_transformed_position();
        this._chatWindow.set_position(x, y - this._chatHeight - 10);
        this._chatWindow.show();
        this._chatOpen = true;
        this._arrowIcon.set_icon_name('go-down-symbolic');
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new ClaudePanelApplet(metadata, orientation, panel_height, instance_id);
}
