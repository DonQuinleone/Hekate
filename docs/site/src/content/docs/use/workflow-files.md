---
title: Workflow files
description: A workflow as a YAML file, to keep in a repository, share between projects or move to another instance.
---

Every workflow can be written out as a file and read back in, much as a dashboard can be exported from a monitoring tool. The file holds the whole workflow: its steps, how they connect, the conditions on the way and where each step sits on the canvas. It does not hold the project it came from or whether it is active: a file moves between projects, and a workflow is switched on in the builder, once its problems are fixed.

Files are YAML, saved as `name.workflow.yaml`. Hekate ships three to start from: **Simple approval**, **Conductor first** and **Parallel stakeholders**.

## In the builder

Open a project's workflows (Settings, Workflows) and choose **Code**. Each workflow is shown as its file, with:

- **Copy** and **Download**, to keep or share it.
- **Import**, to read a file in, or one of the templates, over the workflow shown. Nothing is saved yet: Hekate lists what applying it would change (steps added, changed and removed, connectors rewired) and any problems, each with its line; choose **Line** to go to it.
- **Apply**, to save it. A workflow that is switched on keeps running only if the file has no problems that would stop it.
- **Discard**, to go back to the workflow as it is saved.

You can also edit the file in place and apply it. When a project has no workflow yet, **From a template** starts one from a template directly.

## An example

```yaml
# A Hekate workflow: https://donquinleone.github.io/Hekate/use/workflow-files/
hekate: workflow/1
name: Mix approval
nodes:
  - id: start
    event: upload
    name: A version is uploaded
    at: [0, 0]
  - id: approval
    action: approval
    name: Approval
    with:
      who: Reviewer
      rule: Everyone approves
      status: In review
      due: "5"
    at: [320, 0]
  - id: done
    action: finish
    name: Approved
    with:
      status: Approved
    at: [640, 0]
  - id: changes
    action: task
    name: Make the changes
    with:
      who: Producer
    at: [640, 120]
connectors:
  - id: c1
    from: start.happened
    to: approval
  - id: c2
    from: approval.approved
    to: done
  - id: c3
    from: approval.changes
    to: changes
  - id: c4
    from: changes.done
    to: approval
    until: 5
```

## The parts

**`hekate: workflow/1`** comes first and says which version of the format the file is in. A file without it, or with a version this Hekate does not know, is refused.

**`name`** is what the workflow is called.

**`groups`** (optional) frames steps as a stage: each line is a group's id and the name shown on the canvas, as `round: First round`.

**`nodes`** lists the steps, each with:

| Key | |
| --- | --- |
| `id` | How connectors refer to it: letters, digits, hyphens and underscores. |
| `event` or `action` | What it is. Events: `upload`, `folder`, `manual`, `review`, `decision`, `submitted`, `comment`, `resolved`, `task_done`, `due`, `opened`, `download`, `mention`, `recorded`. Actions: `approval` (the builder's *Approval review*), `feedback` (*Feedback review*), `task`, `checks` (the *QA check*: the project's QA rules on the version), `notify`, `status` (*Set status*), `wait`, `share`, `move`, `finish`. |
| `name` | What it is called on the canvas and in a track's history. |
| `group` | The id of the group it belongs to (optional). |
| `with` | Its settings, as the builder's inspector shows them (optional): `who`, `order`, `rule`, `status`, `due`, `to`, `message`, `days`, `expires`, `folder`. |
| `at` | Where it sits on the canvas, as `[x, y]` in pixels (optional; without it, steps are placed in a row). |

**`connectors`** lists how the steps lead on, each with:

| Key | |
| --- | --- |
| `id` | Optional; one is given when it is left out. Keep it when editing a file, as a running track remembers how often a loop was taken by it. |
| `from` | The step and the outcome it leaves by, as `approval.changes`. |
| `to` | The step it leads to. |
| `when` or `unless` | A condition (optional): `kind audio` (or `video`, `document`, `image`), `tag Rush`, or `by guest` (or `member`, who made the decision). `unless` turns it round. |
| `until` | For a loop back to an earlier step: how many times it may be taken. |

Each step's outcomes are the ones the builder shows: an approval ends by `approved`, `mixed` or `changes`; feedback and a task by `done` or `overdue`; a QA check (`checks`) by `passed`, `warnings` or `failed`; an event by `happened`; a notification or a share by `sent`; a status by `set`; a wait by `elapsed`; a move by `moved`. A finish has none.

## Writing YAML by hand

Hekate reads the part of YAML these files need: lines of `key: value` indented with spaces, lists of items starting with a dash, values in single or double quotes (double quotes take JSON's escapes, such as `\n`), lists in brackets and comments after `#`. Put a value in quotes when it starts with a digit or holds a colon followed by a space, a `#` after a space, or a word YAML reads as something else (`yes`, `no`, `true`, `false`, `null`). Anchors, multi-line blocks and braces are not read: write the value in quotes instead.

## When a file is refused

A file that cannot be read is refused before anything changes, with each mistake and the line it is on: a key that is not part of the format, a step type or outcome that does not exist, a connector to a step that is not there. A file that reads but breaks the builder's rules (an action that nothing leads to, a loop with no way out) is shown with those problems against their lines too; it can be kept as a draft and fixed, but will not run until they are.
