# Claude Panel - Cinnamon Desktop Applet

A lightweight Cinnamon panel applet that integrates Claude AI directly into your desktop taskbar.

## What This Does

This applet adds a chat input field directly to your Cinnamon panel, allowing you to interact with Claude AI without leaving your desktop. Simply type your prompt and press Enter or click the send button.

## Features

- **Always-visible input field** - Chat interface embedded directly in your panel
- **Permission modes** - Control how Claude operates:
  - **Normal** (default) - Asks for permission before executing commands
  - **Sudo** - System-level access with permission prompts
  - **Dangerous** - No permission prompts (use with caution)
- **Persistent history** - Conversation history saved between sessions
- **Custom Claude icon** - Orange gradient send button with arrow

## Installation

### Prerequisites

- Cinnamon desktop environment
- Claude npm package installed globally (`npm install -g @anthropic-ai/sdk` or similar)
- Python 3 and GTK3 libraries (should be installed by default on Cinnamon)

### Install the Applet

1. Copy the applet to Cinnamon's applet directory:
   ```bash
   cp -r claude-panel@claude-code ~/.local/share/cinnamon/applets/
   ```

2. Reload Cinnamon to detect the new applet:
   - Press **Alt+F2**
   - Type `r` and press Enter
   - Wait for Cinnamon to restart

3. Add the applet to your panel:
   - Right-click on your panel
   - Select "Applets"
   - Find "Claude Panel" in the list
   - Click the **+** button to add it
   - Close the Applets window

The input field should now appear in your panel!

## Development Workflow

### Making Changes

When developing the applet, follow these steps to see your changes:

1. **Edit files** in `claude-panel@claude-code/` directory in this project
2. **Delete and reinstall** the applet:
   ```bash
   rm -rf ~/.local/share/cinnamon/applets/claude-panel@claude-code
   cp -r claude-panel@claude-code ~/.local/share/cinnamon/applets/
   ```
3. **Reload Cinnamon**: Press **Alt+F2**, type `r`, press Enter
4. **Remove the applet** from your panel:
   - Right-click panel → "Applets"
   - Find "Claude Panel" in the right column (installed applets)
   - Click the **-** button to remove it
5. **Re-add the applet**:
   - Find "Claude Panel" in the left column (available applets)
   - Click the **+** button to add it back

**Important Notes**:
- Cinnamon caches JavaScript files aggressively - you MUST delete and reinstall after changes
- Simply reloading Cinnamon is not enough - you must remove and re-add the applet
- Changes will not appear until you complete all 5 steps above

### Project Structure

```
claude-panel@claude-code/
├── applet.js              # Main applet code
├── metadata.json          # Applet metadata (name, version, etc.)
└── claude-send-icon.svg   # Custom orange Claude send button icon
```

## Configuration

Settings are stored in `~/.config/claude-panel/config.json`:
- `permissionMode`: "normal", "sudo", or "dangerous"

## Usage

1. Click the input field in your panel (or it may auto-focus)
2. Type your prompt
3. Press Enter or click the orange send button (→)
4. Click the gear icon to access settings:
   - Clear History
   - Change permission mode

## Troubleshooting

### Applet doesn't appear after adding
- Make sure you reloaded Cinnamon (Alt+F2, `r`)
- Check error logs: `tail -f ~/.xsession-errors | grep claude`

### Changes not taking effect
- Always reload Cinnamon after file changes
- Cinnamon caches JavaScript - restart is required

### Multi-select issue in settings
- This should be fixed - each permission mode deselects the others when clicked

## TODO

- [ ] Integrate with actual Claude npm CLI
- [ ] Show chat response window
- [ ] Implement conversation history persistence
- [ ] Implement "Clear History" functionality
- [ ] Auto-start on boot
- [ ] Handle sudo password prompts
- [ ] Add keyboard shortcuts
