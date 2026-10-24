---
title: Recorders and the DAW
description: Reading a recorder's timecode in the take log, starting and stopping takes from it, and a player that follows a DAW.
---

The take log can read the recorder live in the control room's browser: each take's timecode in and out come from it, and, if you choose, its takes start and stop as the recorder records. Nothing needs installing on the computer, and nothing the browser hears leaves it; only the takes it logs reach Hekate, as the keys' do.

Choose **Recorder**, beside the log's status, then the kind of recorder, its input, and whether it starts and stops takes. **Connect** asks the browser for what it needs, and only then.

## A DAW, over MIDI

A DAW sends MIDI Time Code, and MIDI Machine Control if asked, to a virtual MIDI port: the IAC Driver on a Mac (Audio MIDI Setup, MIDI Studio), loopMIDI on Windows. Set the DAW to send timecode, and machine control for takes that start as it records, to that port, then choose it as the **MIDI input**.

- **Start and stop takes.** *When the DAW records* starts the next take on the DAW's record strobe and stops it when recording or the transport stops; *when the DAW rolls* starts it as the timecode starts and stops it as it stops; *No* only fills in timecode, for takes you start with the keys.
- **Permissions.** The browser asks to allow MIDI. Starting takes as the DAW records reads machine control, which is a MIDI system message, so it asks to allow those too.
- **Browsers.** Chrome, Edge and Firefox read MIDI. Safari has no Web MIDI: type timecode there, or use another browser in the control room.

Which machine control messages each DAW sends while recording differs; if takes do not start as the DAW records, choose *when the DAW rolls* instead.

## Sound Devices, and other recorders' timecode out

A Sound Devices 8-Series or MixPre has no network interface a browser can reach (its remote apps talk to it over Bluetooth, in a protocol of its own), so the take log reads its **timecode out** instead. Connect the recorder's timecode output to an input of the computer's audio interface, choose that **audio input** and its **channel**, and connect; the browser asks to allow the microphone, which here means that input.

- **Timecode** in and out come from the recorder's own clock, at its frame rate.
- **Start and stop takes.** With the recorder's timecode on *Rec Run*, it runs only while recording, so *when its timecode rolls* starts each take as the recorder records and stops it as the recorder stops.
- **Take numbers** cannot be read this way. Type the recorder's take number in a session numbered by the recorder, or let the import match the files to the logged takes afterwards.

*Another recorder's timecode out* works the same way for any recorder that sends linear timecode.

## Several people in the room

Only the browser that connected a recorder drives takes from it, and only while its take log is open. Everyone else sees the takes in the same live log, and the **Recorder** control says whose browser drives it. Connecting in another browser takes over; the first lets go and says so.

## The player following the DAW

On a recording or a video, the player's **View** menu has **Follow the DAW**. Playback then follows the DAW's MIDI timecode: it plays as the DAW rolls, stops where it stops, and moves only when the two have drifted by more than half a second. **File starts at** is where the file begins on the DAW's timeline; it starts from the file's own time reference where it has one. A member who leads a [listening room](../listen-together/) while following the DAW leads the room from the DAW.
