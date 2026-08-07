"""Shared data structures for moments and cut plans."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import List, Optional


@dataclass
class Moment:
    """A scored candidate span of a single source video."""
    start: float
    end: float
    text: str = ""
    score: float = 0.0            # 0..10 overall interest
    hook: float = 0.0             # 0..10 hook/opener potential
    reason: str = ""
    kind: str = "talk"            # talk | action | broll | peak
    source: str = ""             # source video path

    @property
    def dur(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass
class Clip:
    """A concrete segment selected for the final edit."""
    source: str
    start: float
    end: float
    text: str = ""
    role: str = "body"            # hook | body | payoff | button
    caption: str = ""

    @property
    def dur(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass
class CutPlan:
    duration_key: str
    target: float
    aspect: str
    clips: List[Clip] = field(default_factory=list)
    title: str = ""
    hook_line: str = ""
    caption_full: str = ""
    hashtags: List[str] = field(default_factory=list)
    trend_format: str = ""
    audit_score: float = 0.0
    audit_notes: List[str] = field(default_factory=list)

    @property
    def total(self) -> float:
        return sum(c.dur for c in self.clips)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["total"] = self.total
        return d
