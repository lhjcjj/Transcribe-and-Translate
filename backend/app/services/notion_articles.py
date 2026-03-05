"""Export restructured articles to Notion as 2-column layouts."""
from __future__ import annotations

import re
from typing import Any, Dict, List, Literal, Optional

from datetime import datetime, timezone

import httpx

from app.config import NOTION_API_TOKEN, NOTION_DATABASE_ID_ALT, NOTION_DATABASE_ID_MAIN, NOTION_MENTION_USER_ID


class NotionConfigError(Exception):
    """Raised when Notion integration is not configured."""


class NotionApiError(Exception):
    """Raised when Notion API returns an error."""


def _ensure_config() -> None:
    if not NOTION_API_TOKEN or (not NOTION_DATABASE_ID_MAIN and not NOTION_DATABASE_ID_ALT):
        raise NotionConfigError(
            "Notion integration is not configured (NOTION_API_TOKEN / NOTION_DATABASE_ID_MAIN / NOTION_DATABASE_ID_ALT)."
        )


def _strip_display_name(display_name: str) -> str:
    """Best-effort: remove the '(art)' suffix used for article entries."""
    name = (display_name or "").strip()
    if name.endswith("(art)"):
        name = name[: -len("(art)")].rstrip()
    return name or "Article"


_SECTION_PATTERN = re.compile(r"^(summary|摘要|transcript|翻译)\s*[:：]\s*", re.MULTILINE)


def _parse_article_sections(text: str) -> Dict[str, str]:
    """
    Parse the article text into named sections.

    Expected headers (case-sensitive for non-Chinese, but lowercased on storage):
    - summary：...
    - 摘要：...
    - transcript：...
    - 翻译：...
    """
    raw = (text or "").strip()
    if not raw:
        return {}

    parts = _SECTION_PATTERN.split(raw)
    # parts = [before, header1, content1, header2, content2, ...]
    sections: Dict[str, str] = {}
    if len(parts) < 3:
        return sections

    # Skip parts[0] (content before first header)
    for i in range(1, len(parts), 2):
        if i + 1 >= len(parts):
            break
        header = parts[i].strip()
        content = parts[i + 1].strip()
        if not header:
            continue
        key = header.lower()
        # For Chinese keys, keep the original to make lookup easier
        if header in ("摘要", "翻译"):
            key = header
        existing = sections.get(key)
        sections[key] = f"{existing}\n\n{content}".strip() if existing else content
    return sections


def _get_database_id(database: Optional[Literal["main", "alt"]] = None) -> str:
    """
    Resolve which database id to use based on the provided key.

    Priority:
    - database == "alt"  -> NOTION_DATABASE_ID_ALT (or MAIN as fallback)
    - database == "main" -> NOTION_DATABASE_ID_MAIN (or ALT as fallback)
    - database is None   -> MAIN if set, otherwise ALT
    """
    _ensure_config()
    if database == "alt":
        if NOTION_DATABASE_ID_ALT:
            return NOTION_DATABASE_ID_ALT
        if NOTION_DATABASE_ID_MAIN:
            return NOTION_DATABASE_ID_MAIN
        raise NotionConfigError("No Notion database id configured for 'alt'.")
    if database == "main":
        if NOTION_DATABASE_ID_MAIN:
            return NOTION_DATABASE_ID_MAIN
        if NOTION_DATABASE_ID_ALT:
            return NOTION_DATABASE_ID_ALT
        raise NotionConfigError("No Notion database id configured for 'main'.")

    # Default: prefer MAIN, then ALT
    if NOTION_DATABASE_ID_MAIN:
        return NOTION_DATABASE_ID_MAIN
    if NOTION_DATABASE_ID_ALT:
        return NOTION_DATABASE_ID_ALT
    raise NotionConfigError("No Notion database id configured.")


def _chunk_text(text: str, max_len: int = 1800) -> List[str]:
    """Split long text into chunks within Notion rich_text limits."""
    t = (text or "").strip()
    if not t:
        return []
    chunks: List[str] = []
    start = 0
    length = len(t)
    while start < length:
        end = min(start + max_len, length)
        chunks.append(t[start:end])
        start = end
    return chunks


def _rich_text_paragraphs(text: str) -> List[Dict[str, Any]]:
    """Return a list of paragraph blocks from potentially long text."""
    chunks = _chunk_text(text)
    blocks: List[Dict[str, Any]] = []
    for chunk in chunks:
        blocks.append(
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [
                        {
                            "type": "text",
                            "text": {"content": chunk},
                        }
                    ]
                },
            }
        )
    return blocks


def _column(children_blocks: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "object": "block",
        "type": "column",
        "column": {
            "children": children_blocks,
        },
    }


def _heading_block(text: str) -> Dict[str, Any]:
    return {
        "object": "block",
        "type": "heading_2",
        "heading_2": {
            "rich_text": [
                {
                    "type": "text",
                    "text": {"content": text},
                }
            ]
        },
    }


def export_article_to_notion(
    display_name: str,
    text: str,
    database: Optional[Literal["main", "alt"]] = None,
) -> Dict[str, str | None]:
    """
    Create a Notion page for the given article.

    Layout:
    - First column_list:
        - Left column: sum-transcript (summary section, key 'summary')
        - Right column: sum-translation (Chinese summary, key '摘要')
    - Second column_list:
        - Left column: transcript (key 'transcript')
        - Right column: translation (Chinese full translation, key '翻译')

    Returns dict with 'page_id' and 'url'.
    """
    _ensure_config()
    sections = _parse_article_sections(text)
    sum_transcript = sections.get("summary", "")
    sum_translation = sections.get("摘要", "")
    transcript = sections.get("transcript", "")
    translation = sections.get("翻译", "")

    page_title = _strip_display_name(display_name)

    children: List[Dict[str, Any]] = []

    # First column list: summaries
    if sum_transcript or sum_translation:
        left_children: List[Dict[str, Any]] = []
        right_children: List[Dict[str, Any]] = []
        if sum_transcript:
            left_children.append(_heading_block("Summary"))
            left_children.extend(_rich_text_paragraphs(sum_transcript))
        if sum_translation:
            right_children.append(_heading_block("摘要"))
            right_children.extend(_rich_text_paragraphs(sum_translation))

        children.append(
            {
                "object": "block",
                "type": "column_list",
                "column_list": {
                    "children": [
                        _column(left_children or [_heading_block("Summary")]),
                        _column(right_children or [_heading_block("摘要")]),
                    ]
                },
            }
        )

    # Second column list: full transcript & translation
    if transcript or translation:
        left_children = []
        right_children = []
        if transcript:
            left_children.append(_heading_block("transcript"))
            left_children.extend(_rich_text_paragraphs(transcript))
        if translation:
            right_children.append(_heading_block("翻译"))
            right_children.extend(_rich_text_paragraphs(translation))

        children.append(
            {
                "object": "block",
                "type": "column_list",
                "column_list": {
                    "children": [
                        _column(left_children or [_heading_block("transcript")]),
                        _column(right_children or [_heading_block("翻译")]),
                    ]
                },
            }
        )

    headers = {
        "Authorization": f"Bearer {NOTION_API_TOKEN}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }
    # Database properties:
    # - Title (title): article file name / display name (without "(art)")
    # - Summary (rich_text): Chinese summary (摘要 section)
    # - Date (date): time of push (UTC, ISO 8601, 24h)
    pushed_at_iso = datetime.now(timezone.utc).isoformat()
    payload: Dict[str, Any] = {
        "parent": {"database_id": _get_database_id(database)},
        "properties": {
            "Title": {
                "title": [
                    {
                        "type": "text",
                        "text": {"content": page_title},
                    }
                ]
            },
            "Summary": {
                "rich_text": [
                    {
                        "type": "text",
                        "text": {"content": sum_translation or ""},
                    }
                ]
                if sum_translation
                else [],
            },
            "Date": {
                "date": {
                    "start": pushed_at_iso,
                }
            },
        },
        "children": children,
    }

    with httpx.Client(timeout=20.0) as client:
        resp = client.post("https://api.notion.com/v1/pages", headers=headers, json=payload)
        if resp.status_code >= 400:
            raise NotionApiError(f"Notion API returned status {resp.status_code}")
        data = resp.json()

        page_id = data.get("id")
        if page_id:
            try:
                # If NOTION_MENTION_USER_ID is configured, @该用户并附加 FYI；否则只发 FYI 文本。
                if NOTION_MENTION_USER_ID:
                    rich_text: List[Dict[str, Any]] = [
                        {
                            "type": "mention",
                            "mention": {"user": {"id": NOTION_MENTION_USER_ID}},
                        },
                        {
                            "type": "text",
                            "text": {"content": " FYI"},
                        },
                    ]
                else:
                    rich_text = [
                        {
                            "type": "text",
                            "text": {"content": "FYI"},
                        }
                    ]
                comment_payload: Dict[str, Any] = {
                    "parent": {"page_id": page_id},
                    "rich_text": rich_text,
                }
                client.post("https://api.notion.com/v1/comments", headers=headers, json=comment_payload)
            except Exception:
                # Best-effort only; do not fail export when comment creation fails
                pass

    return {
        "page_id": data.get("id"),
        "url": data.get("url"),
    }

