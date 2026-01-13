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
        this._sendIcon = new St.Icon({
            gicon: new Gio.FileIcon({file: iconFile}),
            icon_size: 20
        });
        this._sendButton.set_child(this._sendIcon);

        // Animation state
        this._isAnimating = false;
        this._currentSubprocess = null;
        this._colorIndex = 0;
        // Colors to cycle through while processing
        this._stopColors = ['#e89b00', '#f5a623', '#ff8c00', '#ffaa00', '#d4881c'];

        this._sendButton.connect('clicked', Lang.bind(this, this._onSendButtonClicked));

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
        this._chatHistory = '';
        this._chatClutterText.set_text('');
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
            style: 'height: 24px; background-color: rgba(100,150,255,0.3); border-radius: 5px 5px 0 0; margin-bottom: 3px;',
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
            this._resizeHandle.set_style('height: 24px; background-color: rgba(100,150,255,0.5); border-radius: 5px 5px 0 0; margin-bottom: 3px;');
        }));

        this._resizeHandle.connect('leave-event', Lang.bind(this, function() {
            if (!this._dragging) {
                this._resizeHandle.set_style('height: 24px; background-color: rgba(100,150,255,0.3); border-radius: 5px 5px 0 0; margin-bottom: 3px;');
            }
        }));

        this._resizeHandle.connect('button-press-event', Lang.bind(this, this._onDragStart));

        // Create scrollable chat content area
        this._chatScrollView = new St.ScrollView({
            style: 'padding: 5px;',
            x_expand: true,
            y_expand: true,
            x_fill: true,
            y_fill: true,
            reactive: true,
            overlay_scrollbars: false
        });
        this._chatScrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        // Container for the label - must NOT clip to allow scrolling
        this._chatContainer = new St.BoxLayout({
            vertical: true,
            clip_to_allocation: false
        });

        // Calculate available width for text (window width minus padding)
        let textWidth = this._chatWidth - 30; // Account for padding

        // Use Clutter.Text directly for better height calculation with line wrap
        this._chatClutterText = new Clutter.Text({
            text: '',
            color: Clutter.Color.from_string('#cccccc')[1],
            font_name: 'monospace 10',
            line_wrap: true,
            line_wrap_mode: 0, // Pango.WrapMode.WORD_CHAR
            selectable: true,
            reactive: true,
            width: textWidth
        });

        // Wrap in St.Bin for proper St widget integration
        this._chatText = new St.Bin({
            child: this._chatClutterText,
            style: 'padding: 5px;',
            x_fill: true,
            y_fill: false
        });

        // Initialize chat history
        this._chatHistory = '';

        // Track if chat text has keyboard focus
        this._chatTextFocused = false;

        // Handle clicks on the chat text - grab focus on left click, copy on right click
        this._chatClutterText.connect('button-press-event', Lang.bind(this, function(actor, event) {
            if (event.get_button() === 1) { // Left click - start selection and grab focus
                this._grabChatFocus();
                return Clutter.EVENT_PROPAGATE; // Let selection work
            } else if (event.get_button() === 3) { // Right click - copy selection
                this._copySelection();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }));

        // Also ensure focus after selection completes
        this._chatClutterText.connect('button-release-event', Lang.bind(this, function(actor, event) {
            if (event.get_button() === 1) {
                // Re-ensure focus after selection
                this._grabChatFocus();
            }
            return Clutter.EVENT_PROPAGATE;
        }));

        // Add to container
        this._chatContainer.add(this._chatText, {
            expand: false,
            x_fill: true,
            y_fill: false,
            x_expand: true,
            y_expand: false
        });
        this._chatScrollView.add_actor(this._chatContainer);

        this._chatWindow.add(this._resizeHandle);
        this._chatWindow.add(this._chatScrollView, { expand: true });

        // Connect scroll event directly to chat window for mouse wheel scrolling without needing focus
        this._chatWindow.connect('scroll-event', Lang.bind(this, this._onChatScroll));

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

        // Use modal grab to capture all pointer events during drag
        Main.pushModal(this._resizeHandle);

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
            this._resizeHandle.set_style('height: 24px; background-color: rgba(100,150,255,0.3); border-radius: 5px 5px 0 0; margin-bottom: 3px;');

            // Release the modal grab
            Main.popModal(this._resizeHandle);

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

            // Log scroll state after resize
            let vscroll = this._chatScrollView.get_vscroll_bar();
            if (vscroll) {
                let adj = vscroll.get_adjustment();
                global.log("Claude Panel: RESIZE - scroll upper=" + adj.upper + " page=" + adj.page_size);
            }
        }
        return false;
    }

    _onArrowClicked() {
        // Toggle chat window
        if (this._chatOpen) {
            this._releaseChatFocus();
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

    _onSendButtonClicked() {
        // If currently processing, stop it
        if (this._isAnimating && this._currentSubprocess) {
            this._stopClaude();
            return;
        }

        // Otherwise send message
        this._onSendMessage();
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

            // Send to Claude CLI
            this._sendToClaude(message);
        }
    }

    _stopClaude() {
        global.log("Claude Panel: Stopping Claude process");

        if (this._currentSubprocess) {
            this._currentSubprocess.force_exit();
            this._currentSubprocess = null;
        }

        // Add stopped message to chat
        this._chatHistory += ' (stopped)\n';
        this._chatClutterText.set_text(this._chatHistory);

        this._stopThinkingAnimation();
    }

    _sendToClaude(message) {
        try {
            // Start thinking animation
            this._startThinkingAnimation();

            // Use interactive mode with JSON stream - pipe message to stdin
            let cmd = ['claude', '--output-format', 'stream-json', '--verbose'];

            // Create subprocess with stdin pipe
            let subprocess = new Gio.Subprocess({
                argv: cmd,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE | Gio.SubprocessFlags.STDIN_PIPE
            });
            subprocess.init(null);

            // Store reference so we can stop it
            this._currentSubprocess = subprocess;

            // Write message to stdin and close it
            let stdin = subprocess.get_stdin_pipe();
            stdin.write_all(message + '\n', null);
            stdin.close(null);

            // Read stdout asynchronously (JSON stream)
            let stdout = subprocess.get_stdout_pipe();
            let dataInputStream = new Gio.DataInputStream({
                base_stream: stdout
            });

            // Add placeholder for response (with blank line separator)
            this._chatHistory += '\n< ...';
            this._chatClutterText.set_text(this._chatHistory);

            // Read JSON stream
            this._readClaudeJsonStream(dataInputStream, '');

        } catch(e) {
            global.log("Claude Panel: Error calling claude - " + e);
            this._addChatMessage('claude', 'Error: ' + e.message);
            this._stopThinkingAnimation();
        }
    }

    _readClaudeJsonStream(stream, responseText) {
        // Read and parse Claude stream-json output like autoclank does
        stream.read_line_async(GLib.PRIORITY_DEFAULT, null, Lang.bind(this, function(stream, result) {
            try {
                let [line] = stream.read_line_finish_utf8(result);
                if (line !== null) {
                    // Parse JSON line
                    try {
                        let event = JSON.parse(line);
                        global.log("Claude Panel: Event type=" + event.type);

                        // Cycle color on any event (shows activity)
                        this._cycleStopButtonColor();

                        // Process based on event type (matching autoclank agent logic)
                        switch (event.type) {
                            case 'assistant':
                                // Assistant message - parse content blocks
                                if (event.message && event.message.content) {
                                    for (let i = 0; i < event.message.content.length; i++) {
                                        let block = event.message.content[i];
                                        if (block.type === 'tool_use') {
                                            // Show tool being used - accumulate in activity log
                                            let toolInfo = this._formatToolUse(block.name, block.input);
                                            if (!this._activityLog) this._activityLog = '';
                                            this._activityLog += '\n' + toolInfo;
                                            // Update display
                                            this._chatHistory += '\n' + toolInfo;
                                            this._chatClutterText.set_text(this._chatHistory);
                                            this._scrollToBottom();
                                        }
                                    }
                                }
                                break;

                            case 'user':
                                // Tool result events - we get permission denials from result event instead
                                break;

                            case 'result':
                                // Final result - show response with activities
                                let finalText = '';
                                if (event.subtype === 'success' && event.result) {
                                    finalText = event.result;
                                }

                                // Show permission denials if any
                                if (event.permission_denials && event.permission_denials.length > 0) {
                                    for (let i = 0; i < event.permission_denials.length; i++) {
                                        let denial = event.permission_denials[i];
                                        finalText += '\n[Permission denied: ' + denial.tool_name + ']';
                                    }
                                }

                                // Find where response started and rebuild
                                let lastResponseStart = this._chatHistory.lastIndexOf('\n< ...');
                                if (lastResponseStart !== -1) {
                                    // Keep everything before the placeholder, add result + activities
                                    this._chatHistory = this._chatHistory.substring(0, lastResponseStart + 3) + finalText;
                                    if (this._activityLog) {
                                        this._chatHistory += this._activityLog;
                                    }
                                } else {
                                    this._chatHistory += finalText;
                                }
                                this._chatHistory += '\n';
                                this._activityLog = '';  // Reset for next message

                                if (event.subtype === 'error') {
                                    this._chatHistory += '[Error]\n';
                                }
                                this._chatClutterText.set_text(this._chatHistory);
                                this._scrollToBottom();
                                this._stopThinkingAnimation();
                                return;
                        }
                    } catch(parseErr) {
                        global.log("Claude Panel: JSON parse error: " + parseErr);
                    }

                    // Continue reading
                    this._readClaudeJsonStream(stream, responseText);
                } else {
                    // Stream ended
                    this._stopThinkingAnimation();
                    this._chatHistory += '\n';
                    this._chatClutterText.set_text(this._chatHistory);
                    this._scrollToBottom();
                }
            } catch(e) {
                global.log("Claude Panel: Error reading output - " + e);
                this._chatHistory += 'Error: ' + e.message + '\n';
                this._chatClutterText.set_text(this._chatHistory);
                this._stopThinkingAnimation();
            }
        }));
    }

    _appendToChat(text) {
        // Simply append text to chat history
        this._chatHistory += '\n' + text;
        this._chatClutterText.set_text(this._chatHistory);
        this._scrollToBottom();
    }

    _formatToolUse(toolName, input) {
        // Format tool use info like autoclank does
        let info = '[' + toolName + ']';

        if (!input) return info;

        try {
            switch (toolName) {
                case 'Edit':
                    if (input.file_path) {
                        info = '[Edit: ' + input.file_path + ']';
                    }
                    break;
                case 'Write':
                    if (input.file_path) {
                        info = '[Write: ' + input.file_path + ']';
                    }
                    break;
                case 'Read':
                    if (input.file_path) {
                        info = '[Read: ' + input.file_path + ']';
                    }
                    break;
                case 'Bash':
                    if (input.command) {
                        let cmd = input.command;
                        if (cmd.length > 40) {
                            cmd = cmd.substring(0, 40) + '...';
                        }
                        info = '[$ ' + cmd + ']';
                    }
                    break;
                case 'Grep':
                case 'Glob':
                    info = '[Searching...]';
                    break;
                case 'TodoWrite':
                    info = '[Updating tasks...]';
                    break;
            }
        } catch(e) {
            global.log("Claude Panel: Error formatting tool use: " + e);
        }

        return info;
    }

    _addChatMessage(sender, text) {
        let isUser = sender === 'user';
        let prefix = isUser ? '> ' : '< ';

        // Add blank line before message if there's existing content
        if (this._chatHistory.length > 0) {
            this._chatHistory += '\n';
        }
        this._chatHistory += prefix + text + '\n';
        this._chatClutterText.set_text(this._chatHistory);
    }

    _copySelection() {
        let selection = this._chatClutterText.get_selection();
        if (selection && selection.length > 0) {
            let clipboard = St.Clipboard.get_default();
            clipboard.set_text(St.ClipboardType.CLIPBOARD, selection);
            global.log("Claude Panel: Copied to clipboard");
        }
    }

    _grabChatFocus() {
        if (!this._chatTextFocused) {
            this._chatTextFocused = true;

            // Mirror the entry focus pattern exactly
            Main.pushModal(this._chatText);
            this._chatClutterText.grab_key_focus();

            // Use captured-event to intercept ALL events before they reach targets
            // This handles scroll, keys, and button presses all in one place
            this._chatCapturedEventId = global.stage.connect('captured-event', Lang.bind(this, function(stageActor, stageEvent) {
                let type = stageEvent.type();

                // Handle scroll events (mouse wheel)
                if (type === Clutter.EventType.SCROLL) {
                    global.log("Claude Panel: SCROLL event received");
                    let vscroll = this._chatScrollView.get_vscroll_bar();
                    if (vscroll) {
                        let adjustment = vscroll.get_adjustment();
                        let step = 50; // pixels to scroll per wheel tick
                        let direction = stageEvent.get_scroll_direction();
                        global.log("Claude Panel: scroll direction=" + direction + " current=" + adjustment.get_value() + " upper=" + adjustment.upper + " page=" + adjustment.page_size);

                        if (direction === Clutter.ScrollDirection.UP) {
                            adjustment.set_value(adjustment.get_value() - step);
                            return Clutter.EVENT_STOP;
                        } else if (direction === Clutter.ScrollDirection.DOWN) {
                            adjustment.set_value(adjustment.get_value() + step);
                            return Clutter.EVENT_STOP;
                        }
                    } else {
                        global.log("Claude Panel: no vscroll bar!");
                    }
                    return Clutter.EVENT_PROPAGATE;
                }

                // Handle key press events (arrow keys, Ctrl+C, etc)
                if (type === Clutter.EventType.KEY_PRESS) {
                    let state = stageEvent.get_state();
                    let symbol = stageEvent.get_key_symbol();
                    global.log("Claude Panel: KEY_PRESS symbol=" + symbol + " Up=" + Clutter.KEY_Up + " Down=" + Clutter.KEY_Down);

                    // Check for Ctrl+C
                    if ((state & Clutter.ModifierType.CONTROL_MASK) && (symbol === Clutter.KEY_c || symbol === Clutter.KEY_C)) {
                        this._copySelection();
                        return Clutter.EVENT_STOP;
                    }

                    // Check for Ctrl+A - select all
                    if ((state & Clutter.ModifierType.CONTROL_MASK) && (symbol === Clutter.KEY_a || symbol === Clutter.KEY_A)) {
                        let text = this._chatClutterText.get_text();
                        this._chatClutterText.set_selection(0, text.length);
                        return Clutter.EVENT_STOP;
                    }

                    // Escape releases focus
                    if (symbol === Clutter.KEY_Escape) {
                        this._releaseChatFocus();
                        return Clutter.EVENT_STOP;
                    }

                    // Arrow keys for scrolling (use numeric values as fallback)
                    // Up=65362, Down=65364, Page_Up=65365, Page_Down=65366, Home=65360, End=65367
                    if (symbol === Clutter.KEY_Up || symbol === 65362) {
                        global.log("Claude Panel: UP arrow detected, scrolling");
                        this._scrollByAmount(-30);
                        return Clutter.EVENT_STOP;
                    }
                    if (symbol === Clutter.KEY_Down || symbol === 65364) {
                        global.log("Claude Panel: DOWN arrow detected, scrolling");
                        this._scrollByAmount(30);
                        return Clutter.EVENT_STOP;
                    }
                    if (symbol === Clutter.KEY_Page_Up || symbol === 65365) {
                        this._scrollByAmount(-150);
                        return Clutter.EVENT_STOP;
                    }
                    if (symbol === Clutter.KEY_Page_Down || symbol === 65366) {
                        this._scrollByAmount(150);
                        return Clutter.EVENT_STOP;
                    }
                    if (symbol === Clutter.KEY_Home || symbol === 65360) {
                        this._scrollByAmount(-99999); // Scroll to top
                        return Clutter.EVENT_STOP;
                    }
                    if (symbol === Clutter.KEY_End || symbol === 65367) {
                        this._scrollByAmount(99999); // Scroll to bottom
                        return Clutter.EVENT_STOP;
                    }

                    return Clutter.EVENT_PROPAGATE;
                }

                // Handle button press events for releasing focus
                if (type === Clutter.EventType.BUTTON_PRESS) {
                    let dominated = this._chatText.contains(stageEvent.get_source());
                    if (!dominated) {
                        this._releaseChatFocus();
                        return Clutter.EVENT_PROPAGATE; // Let click through
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            }));

            global.log("Claude Panel: Chat focus grabbed");
        }
    }

    _releaseChatFocus() {
        if (this._chatTextFocused) {
            if (this._chatCapturedEventId) {
                global.stage.disconnect(this._chatCapturedEventId);
                this._chatCapturedEventId = null;
            }
            Main.popModal(this._chatText);
            this._chatTextFocused = false;
            global.log("Claude Panel: Chat focus released");
        }
    }

    _onChatScroll(actor, event) {
        // Handle mouse wheel scrolling on the chat window
        let vscroll = this._chatScrollView.get_vscroll_bar();
        if (vscroll) {
            let adjustment = vscroll.get_adjustment();
            let step = 50; // pixels to scroll per wheel tick
            let direction = event.get_scroll_direction();

            if (direction === Clutter.ScrollDirection.UP) {
                adjustment.set_value(adjustment.get_value() - step);
                return Clutter.EVENT_STOP;
            } else if (direction === Clutter.ScrollDirection.DOWN) {
                adjustment.set_value(adjustment.get_value() + step);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _scrollByAmount(amount) {
        // Helper to scroll by a given amount (positive = down, negative = up)
        let vscroll = this._chatScrollView.get_vscroll_bar();
        global.log("Claude Panel: _scrollByAmount(" + amount + ") vscroll=" + vscroll);
        if (vscroll) {
            let adjustment = vscroll.get_adjustment();
            let oldValue = adjustment.get_value();
            let newValue = oldValue + amount;
            // Clamp to valid range
            newValue = Math.max(0, Math.min(newValue, adjustment.upper - adjustment.page_size));
            global.log("Claude Panel: scroll old=" + oldValue + " new=" + newValue + " upper=" + adjustment.upper + " page=" + adjustment.page_size);
            adjustment.set_value(newValue);
        }
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

        // Debug: log scroll state after window opens
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, Lang.bind(this, function() {
            let vscroll = this._chatScrollView.get_vscroll_bar();
            if (vscroll) {
                let adj = vscroll.get_adjustment();
                global.log("Claude Panel: OPEN - scroll upper=" + adj.upper + " page=" + adj.page_size + " value=" + adj.get_value());
                global.log("Claude Panel: OPEN - label height=" + this._chatText.get_height() + " container height=" + this._chatContainer.get_height());
            }
            return GLib.SOURCE_REMOVE;
        }));
    }

    _startThinkingAnimation() {
        if (this._isAnimating) return;

        this._isAnimating = true;

        // Change icon to square stop icon (media-playback-stop)
        this._sendIcon.set_icon_name('media-playback-stop-symbolic');
        this._sendIcon.set_gicon(null);

        // Set orange/amber background like VS Code working indicator
        this._sendButton.set_style('padding: 4px 4px; background-color: #e89b00; border-radius: 3px;');
        this._sendIcon.set_style('color: white;');

        global.log("Claude Panel: Started thinking animation");
    }

    _cycleStopButtonColor() {
        // Cycle through colors on each status update
        global.log("Claude Panel: _cycleStopButtonColor called, isAnimating=" + this._isAnimating);
        if (!this._isAnimating) return;

        // Move to next color
        this._colorIndex = (this._colorIndex + 1) % this._stopColors.length;
        let color = this._stopColors[this._colorIndex];
        global.log("Claude Panel: Cycling to color index " + this._colorIndex + " = " + color);

        // Recreate the stop icon fresh to avoid style issues
        this._sendIcon.destroy();
        this._sendIcon = new St.Icon({
            icon_name: 'media-playback-stop-symbolic',
            icon_size: 20
        });
        this._sendIcon.set_style('color: white;');
        this._sendButton.set_child(this._sendIcon);

        this._sendButton.set_style('padding: 4px 4px; background-color: ' + color + '; border-radius: 3px;');
        global.log("Claude Panel: Button style set to background-color: " + color);
    }

    _stopThinkingAnimation() {
        this._isAnimating = false;
        this._currentSubprocess = null;
        this._colorIndex = 0;

        // Destroy old icon and create fresh one
        this._sendIcon.destroy();

        let iconPath = GLib.build_filenamev([global.userdatadir, 'applets', 'claude-panel@claude-code', 'claude-send-icon.svg']);
        let iconFile = Gio.File.new_for_path(iconPath);
        this._sendIcon = new St.Icon({
            gicon: new Gio.FileIcon({file: iconFile}),
            icon_size: 20
        });
        this._sendButton.set_child(this._sendIcon);

        // Reset button style to default
        this._sendButton.set_style('padding: 4px 4px;');

        global.log("Claude Panel: Stopped thinking animation");
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new ClaudePanelApplet(metadata, orientation, panel_height, instance_id);
}
