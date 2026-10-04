"""Narrow local-file bridge. No plugins, URL fetching, or LLM configuration."""
import sys

try:
    from markitdown import MarkItDown
except ImportError:
    sys.stderr.write('Optional dependency missing. Run: python -m pip install "markitdown[docx,xls,xlsx,pptx,pdf]" using the selected Python interpreter.\n')
    sys.exit(2)

try:
    result = MarkItDown(enable_plugins=False).convert_local(sys.argv[1])
    sys.stdout.write(result.markdown)
except Exception as error:
    sys.stderr.write(f'{type(error).__name__}: {error}\nIf a format dependency is missing, run: python -m pip install "markitdown[docx,xls,xlsx,pptx,pdf]"\n')
    sys.exit(1)
