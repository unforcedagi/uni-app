#!/usr/bin/env python3
"""T-204: answers the real GTK Save dialog through accessibility (AT-SPI), as a screen reader user would, because
cage has no pointer and wtype's Return and BackSpace don't reach GTK's file chooser there. When the in-page driver
writes dialog.req, this finds the app's Save dialog, records what its Name field and folder say (dialog.json),
then presses its Save button (action "click"); dialog.ack says it did.
usage: atspi_save.py <out dir>   (inside the same D-Bus session as the app)"""
import json, os, sys, time
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

out = sys.argv[1]


def walk(node, depth=0):
    if node is None or depth > 40:
        return
    yield node
    for i in range(node.get_child_count()):
        try:
            yield from walk(node.get_child_at_index(i), depth + 1)
        except Exception:
            pass


def find_dialog():
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        for node in walk(app):
            role = node.get_role()
            if role in (Atspi.Role.FILE_CHOOSER, Atspi.Role.DIALOG) and node.get_name() in ("Save File", "Save"):
                return node
    return None


def text_of(node):
    try:
        t = node.get_text_iface() if hasattr(node, "get_text_iface") else node
        return Atspi.Text.get_text(t, 0, Atspi.Text.get_character_count(t))
    except Exception:
        return None


done = False
while not done:
    if os.path.exists(f"{out}/dialog.req"):
        info, save = {}, None
        for _ in range(100):
            dialog = find_dialog()
            if dialog:
                for node in walk(dialog):
                    role, name = node.get_role(), node.get_name()
                    if role == Atspi.Role.PUSH_BUTTON and name in ("Save", "_Save"):
                        save = node
                    elif role == Atspi.Role.TEXT and "name" not in info and text_of(node):
                        info["name"] = text_of(node)
                    elif role == Atspi.Role.TOGGLE_BUTTON and node.get_state_set().contains(Atspi.StateType.CHECKED):
                        info.setdefault("path_bar_selected", name)
                if save:
                    break
            time.sleep(0.1)
        info["found_save"] = save is not None
        json.dump(info, open(f"{out}/dialog.json", "w"), ensure_ascii=False)
        if save:
            time.sleep(1.0)  # leave the dialog on screen for the recording
            action = save.get_action_iface() if hasattr(save, "get_action_iface") else save
            Atspi.Action.do_action(action, 0)
        open(f"{out}/dialog.ack", "w").write("pressed" if save else "no Save button")
        done = True
    time.sleep(0.1)
