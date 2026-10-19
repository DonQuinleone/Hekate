"""The one call of setuptools' pkg_resources the EBU ADM Renderer makes (decision 140).

ear reads its own data files (loudspeaker layouts, common definitions) with
pkg_resources.resource_stream. setuptools no longer ships pkg_resources, and the last
releases that did carry a known vulnerability, so this stands in for it with the standard
library, and setuptools stays out of the image.
"""

from importlib.resources import files


def resource_stream(module, name):
    """A binary stream of the file `name` beside the module or package `module`."""
    return files(module).joinpath(name).open("rb")
