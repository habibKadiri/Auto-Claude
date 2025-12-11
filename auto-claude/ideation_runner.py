#!/usr/bin/env python3
"""
Ideation Creation Orchestrator
==============================

AI-powered ideation generation for projects.
Analyzes project context, existing features, and generates three types of ideas:
1. Low-Hanging Fruit - Quick wins building on existing patterns
2. UI/UX Improvements - Visual and interaction enhancements
3. High-Value Features - Strategic features for target users

Usage:
    python auto-claude/ideation_runner.py --project /path/to/project
    python auto-claude/ideation_runner.py --project /path/to/project --types low_hanging_fruit,high_value_features
    python auto-claude/ideation_runner.py --project /path/to/project --refresh
"""

import asyncio
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional, List

# Add auto-claude to path
sys.path.insert(0, str(Path(__file__).parent))

# Load .env file
from dotenv import load_dotenv
env_file = Path(__file__).parent / ".env"
if env_file.exists():
    load_dotenv(env_file)

from client import create_client
from ui import (
    Icons,
    icon,
    box,
    success,
    error,
    warning,
    info,
    muted,
    highlight,
    bold,
    print_status,
    print_key_value,
    print_section,
)


# Configuration
MAX_RETRIES = 3
PROMPTS_DIR = Path(__file__).parent / "prompts"

# Ideation types
IDEATION_TYPES = [
    "low_hanging_fruit",
    "ui_ux_improvements",
    "high_value_features",
    "documentation_gaps",
    "security_hardening",
    "performance_optimizations",
    "code_quality",
]

IDEATION_TYPE_LABELS = {
    "low_hanging_fruit": "Low-Hanging Fruit",
    "ui_ux_improvements": "UI/UX Improvements",
    "high_value_features": "High-Value Features",
    "documentation_gaps": "Documentation Gaps",
    "security_hardening": "Security Hardening",
    "performance_optimizations": "Performance Optimizations",
    "code_quality": "Code Quality & Refactoring",
}

IDEATION_TYPE_PROMPTS = {
    "low_hanging_fruit": "ideation_low_hanging_fruit.md",
    "ui_ux_improvements": "ideation_ui_ux.md",
    "high_value_features": "ideation_high_value.md",
    "documentation_gaps": "ideation_documentation.md",
    "security_hardening": "ideation_security.md",
    "performance_optimizations": "ideation_performance.md",
    "code_quality": "ideation_code_quality.md",
}


@dataclass
class IdeationPhaseResult:
    """Result of an ideation phase execution."""
    phase: str
    ideation_type: Optional[str]
    success: bool
    output_files: list[str]
    ideas_count: int
    errors: list[str]
    retries: int


@dataclass
class IdeationConfig:
    """Configuration for ideation generation."""
    project_dir: Path
    output_dir: Path
    enabled_types: List[str] = field(default_factory=lambda: IDEATION_TYPES.copy())
    include_roadmap_context: bool = True
    include_kanban_context: bool = True
    max_ideas_per_type: int = 5
    model: str = "claude-sonnet-4-20250514"
    refresh: bool = False


class IdeationOrchestrator:
    """Orchestrates the ideation creation process."""

    def __init__(
        self,
        project_dir: Path,
        output_dir: Optional[Path] = None,
        enabled_types: Optional[List[str]] = None,
        include_roadmap_context: bool = True,
        include_kanban_context: bool = True,
        max_ideas_per_type: int = 5,
        model: str = "claude-sonnet-4-20250514",
        refresh: bool = False,
    ):
        self.project_dir = Path(project_dir)
        self.model = model
        self.refresh = refresh
        self.enabled_types = enabled_types or IDEATION_TYPES.copy()
        self.include_roadmap_context = include_roadmap_context
        self.include_kanban_context = include_kanban_context
        self.max_ideas_per_type = max_ideas_per_type

        # Default output to project's auto-claude directory
        if output_dir:
            self.output_dir = Path(output_dir)
        else:
            self.output_dir = self.project_dir / "auto-claude" / "ideation"

        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Create screenshots directory for UI/UX analysis
        (self.output_dir / "screenshots").mkdir(exist_ok=True)

    def _run_script(self, script: str, args: list[str]) -> tuple[bool, str]:
        """Run a Python script and return (success, output)."""
        script_path = Path(__file__).parent / script

        if not script_path.exists():
            return False, f"Script not found: {script_path}"

        cmd = [sys.executable, str(script_path)] + args

        try:
            result = subprocess.run(
                cmd,
                cwd=self.project_dir,
                capture_output=True,
                text=True,
                timeout=300,
            )

            if result.returncode == 0:
                return True, result.stdout
            else:
                return False, result.stderr or result.stdout

        except subprocess.TimeoutExpired:
            return False, "Script timed out"
        except Exception as e:
            return False, str(e)

    async def _run_agent(
        self,
        prompt_file: str,
        additional_context: str = "",
    ) -> tuple[bool, str]:
        """Run an agent with the given prompt."""
        prompt_path = PROMPTS_DIR / prompt_file

        if not prompt_path.exists():
            return False, f"Prompt not found: {prompt_path}"

        # Load prompt
        prompt = prompt_path.read_text()

        # Add context
        prompt += f"\n\n---\n\n**Output Directory**: {self.output_dir}\n"
        prompt += f"**Project Directory**: {self.project_dir}\n"
        prompt += f"**Max Ideas**: {self.max_ideas_per_type}\n"

        if additional_context:
            prompt += f"\n{additional_context}\n"

        # Create client
        client = create_client(self.project_dir, self.output_dir, self.model)

        try:
            async with client:
                await client.query(prompt)

                response_text = ""
                async for msg in client.receive_response():
                    msg_type = type(msg).__name__

                    if msg_type == "AssistantMessage" and hasattr(msg, "content"):
                        for block in msg.content:
                            block_type = type(block).__name__
                            if block_type == "TextBlock" and hasattr(block, "text"):
                                response_text += block.text
                                print(block.text, end="", flush=True)
                            elif block_type == "ToolUseBlock" and hasattr(block, "name"):
                                print(f"\n[Tool: {block.name}]", flush=True)

                print()
                return True, response_text

        except Exception as e:
            return False, str(e)

    def _gather_context(self) -> dict:
        """Gather context from project for ideation."""
        context = {
            "existing_features": [],
            "tech_stack": [],
            "target_audience": None,
            "planned_features": [],
        }

        # Get project index
        project_index_path = self.project_dir / "auto-claude" / "project_index.json"
        if project_index_path.exists():
            try:
                with open(project_index_path) as f:
                    index = json.load(f)
                    # Extract tech stack from services
                    for service_name, service_info in index.get("services", {}).items():
                        if service_info.get("language"):
                            context["tech_stack"].append(service_info["language"])
                        if service_info.get("framework"):
                            context["tech_stack"].append(service_info["framework"])
                    context["tech_stack"] = list(set(context["tech_stack"]))
            except (json.JSONDecodeError, KeyError):
                pass

        # Get roadmap context if enabled
        if self.include_roadmap_context:
            roadmap_path = self.project_dir / "auto-claude" / "roadmap" / "roadmap.json"
            if roadmap_path.exists():
                try:
                    with open(roadmap_path) as f:
                        roadmap = json.load(f)
                        # Extract planned features
                        for feature in roadmap.get("features", []):
                            context["planned_features"].append(feature.get("title", ""))
                        # Get target audience
                        audience = roadmap.get("target_audience", {})
                        context["target_audience"] = audience.get("primary")
                except (json.JSONDecodeError, KeyError):
                    pass

            # Also check discovery for audience
            discovery_path = self.project_dir / "auto-claude" / "roadmap" / "roadmap_discovery.json"
            if discovery_path.exists() and not context["target_audience"]:
                try:
                    with open(discovery_path) as f:
                        discovery = json.load(f)
                        audience = discovery.get("target_audience", {})
                        context["target_audience"] = audience.get("primary_persona")

                        # Also get existing features
                        current_state = discovery.get("current_state", {})
                        context["existing_features"] = current_state.get("existing_features", [])
                except (json.JSONDecodeError, KeyError):
                    pass

        # Get kanban context if enabled
        if self.include_kanban_context:
            specs_dir = self.project_dir / "auto-claude" / "specs"
            if specs_dir.exists():
                for spec_dir in specs_dir.iterdir():
                    if spec_dir.is_dir():
                        spec_file = spec_dir / "spec.md"
                        if spec_file.exists():
                            # Extract title from spec
                            content = spec_file.read_text()
                            lines = content.split("\n")
                            for line in lines:
                                if line.startswith("# "):
                                    context["planned_features"].append(line[2:].strip())
                                    break

        # Remove duplicates from planned features
        context["planned_features"] = list(set(context["planned_features"]))

        return context

    async def phase_context(self) -> IdeationPhaseResult:
        """Create ideation context file."""

        context_file = self.output_dir / "ideation_context.json"

        print_status("Gathering project context...", "progress")

        context = self._gather_context()

        # Write context file
        context_data = {
            "existing_features": context["existing_features"],
            "tech_stack": context["tech_stack"],
            "target_audience": context["target_audience"],
            "planned_features": context["planned_features"],
            "config": {
                "enabled_types": self.enabled_types,
                "include_roadmap_context": self.include_roadmap_context,
                "include_kanban_context": self.include_kanban_context,
                "max_ideas_per_type": self.max_ideas_per_type,
            },
            "created_at": datetime.now().isoformat(),
        }

        with open(context_file, "w") as f:
            json.dump(context_data, f, indent=2)

        print_status(f"Created ideation_context.json", "success")
        print_key_value("Tech Stack", ", ".join(context["tech_stack"][:5]) or "Unknown")
        print_key_value("Planned Features", str(len(context["planned_features"])))
        print_key_value("Target Audience", context["target_audience"] or "Not specified")

        return IdeationPhaseResult(
            phase="context",
            ideation_type=None,
            success=True,
            output_files=[str(context_file)],
            ideas_count=0,
            errors=[],
            retries=0,
        )

    async def phase_project_index(self) -> IdeationPhaseResult:
        """Ensure project index exists."""

        project_index = self.output_dir / "project_index.json"
        auto_build_index = self.project_dir / "auto-claude" / "project_index.json"

        # Check if we can copy existing index
        if auto_build_index.exists():
            import shutil
            shutil.copy(auto_build_index, project_index)
            print_status("Copied existing project_index.json", "success")
            return IdeationPhaseResult("project_index", None, True, [str(project_index)], 0, [], 0)

        if project_index.exists() and not self.refresh:
            print_status("project_index.json already exists", "success")
            return IdeationPhaseResult("project_index", None, True, [str(project_index)], 0, [], 0)

        # Run analyzer
        print_status("Running project analyzer...", "progress")
        success, output = self._run_script(
            "analyzer.py",
            ["--output", str(project_index)]
        )

        if success and project_index.exists():
            print_status("Created project_index.json", "success")
            return IdeationPhaseResult("project_index", None, True, [str(project_index)], 0, [], 0)

        return IdeationPhaseResult("project_index", None, False, [], 0, [output], 1)

    async def phase_ideation_type(self, ideation_type: str) -> IdeationPhaseResult:
        """Run ideation for a specific type."""

        prompt_file = IDEATION_TYPE_PROMPTS.get(ideation_type)
        if not prompt_file:
            return IdeationPhaseResult(
                phase="ideation",
                ideation_type=ideation_type,
                success=False,
                output_files=[],
                ideas_count=0,
                errors=[f"Unknown ideation type: {ideation_type}"],
                retries=0,
            )

        output_file = self.output_dir / f"{ideation_type}_ideas.json"

        if output_file.exists() and not self.refresh:
            # Load and count existing ideas
            try:
                with open(output_file) as f:
                    data = json.load(f)
                    count = len(data.get(ideation_type, []))
                print_status(f"{ideation_type}_ideas.json already exists ({count} ideas)", "success")
                return IdeationPhaseResult(
                    phase="ideation",
                    ideation_type=ideation_type,
                    success=True,
                    output_files=[str(output_file)],
                    ideas_count=count,
                    errors=[],
                    retries=0,
                )
            except (json.JSONDecodeError, KeyError):
                pass

        errors = []
        for attempt in range(MAX_RETRIES):
            print_status(f"Running {IDEATION_TYPE_LABELS[ideation_type]} agent (attempt {attempt + 1})...", "progress")

            context = f"""
**Ideation Context**: {self.output_dir / "ideation_context.json"}
**Project Index**: {self.output_dir / "project_index.json"}
**Output File**: {output_file}
**Max Ideas**: {self.max_ideas_per_type}

Generate up to {self.max_ideas_per_type} {IDEATION_TYPE_LABELS[ideation_type]} ideas.
Avoid duplicating features that are already planned (see ideation_context.json).
Output your ideas to {output_file.name}.
"""
            success, output = await self._run_agent(
                prompt_file,
                additional_context=context,
            )

            if success and output_file.exists():
                # Validate
                try:
                    with open(output_file) as f:
                        data = json.load(f)

                    ideas = data.get(ideation_type, [])

                    if len(ideas) >= 1:
                        print_status(f"Created {output_file.name} ({len(ideas)} ideas)", "success")
                        return IdeationPhaseResult(
                            phase="ideation",
                            ideation_type=ideation_type,
                            success=True,
                            output_files=[str(output_file)],
                            ideas_count=len(ideas),
                            errors=[],
                            retries=attempt,
                        )
                    else:
                        errors.append(f"No {ideation_type} ideas generated")
                except json.JSONDecodeError as e:
                    errors.append(f"Invalid JSON: {e}")
            else:
                errors.append(f"Attempt {attempt + 1}: Agent did not create output file")

        return IdeationPhaseResult(
            phase="ideation",
            ideation_type=ideation_type,
            success=False,
            output_files=[],
            ideas_count=0,
            errors=errors,
            retries=MAX_RETRIES,
        )

    async def phase_merge(self) -> IdeationPhaseResult:
        """Merge all ideation outputs into a single ideation.json."""

        ideation_file = self.output_dir / "ideation.json"

        all_ideas = []
        output_files = []

        for ideation_type in self.enabled_types:
            type_file = self.output_dir / f"{ideation_type}_ideas.json"
            if type_file.exists():
                try:
                    with open(type_file) as f:
                        data = json.load(f)
                        ideas = data.get(ideation_type, [])
                        all_ideas.extend(ideas)
                        output_files.append(str(type_file))
                except (json.JSONDecodeError, KeyError):
                    pass

        # Load context for metadata
        context_file = self.output_dir / "ideation_context.json"
        context_data = {}
        if context_file.exists():
            try:
                with open(context_file) as f:
                    context_data = json.load(f)
            except json.JSONDecodeError:
                pass

        # Create merged ideation session
        ideation_session = {
            "id": f"ideation-{datetime.now().strftime('%Y%m%d-%H%M%S')}",
            "project_id": str(self.project_dir),
            "config": context_data.get("config", {}),
            "ideas": all_ideas,
            "project_context": {
                "existing_features": context_data.get("existing_features", []),
                "tech_stack": context_data.get("tech_stack", []),
                "target_audience": context_data.get("target_audience"),
                "planned_features": context_data.get("planned_features", []),
            },
            "summary": {
                "total_ideas": len(all_ideas),
                "by_type": {},
                "by_status": {"draft": len(all_ideas)},
            },
            "generated_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat(),
        }

        # Count by type
        for idea in all_ideas:
            idea_type = idea.get("type", "unknown")
            ideation_session["summary"]["by_type"][idea_type] = \
                ideation_session["summary"]["by_type"].get(idea_type, 0) + 1

        with open(ideation_file, "w") as f:
            json.dump(ideation_session, f, indent=2)

        print_status(f"Created ideation.json ({len(all_ideas)} total ideas)", "success")

        return IdeationPhaseResult(
            phase="merge",
            ideation_type=None,
            success=True,
            output_files=[str(ideation_file)],
            ideas_count=len(all_ideas),
            errors=[],
            retries=0,
        )

    async def run(self) -> bool:
        """Run the complete ideation generation process."""

        print(box(
            f"Project: {self.project_dir}\n"
            f"Output: {self.output_dir}\n"
            f"Model: {self.model}\n"
            f"Types: {', '.join(self.enabled_types)}",
            title="IDEATION GENERATOR",
            style="heavy"
        ))

        results = []

        # Phase 1: Project Index
        print_section("PHASE 1: PROJECT ANALYSIS", Icons.FOLDER)
        result = await self.phase_project_index()
        results.append(result)
        if not result.success:
            print_status("Project analysis failed", "error")
            return False

        # Phase 2: Context Gathering
        print_section("PHASE 2: CONTEXT GATHERING", Icons.SEARCH)
        result = await self.phase_context()
        results.append(result)
        if not result.success:
            print_status("Context gathering failed", "error")
            return False

        # Phase 3+: Run each enabled ideation type
        phase_num = 3
        for ideation_type in self.enabled_types:
            print_section(
                f"PHASE {phase_num}: {IDEATION_TYPE_LABELS[ideation_type].upper()}",
                Icons.CHUNK
            )
            result = await self.phase_ideation_type(ideation_type)
            results.append(result)

            if not result.success:
                print_status(f"{IDEATION_TYPE_LABELS[ideation_type]} ideation failed", "warning")
                for err in result.errors:
                    print(f"  {muted('Error:')} {err}")
                # Continue with other types even if one fails

            phase_num += 1

        # Final Phase: Merge
        print_section(f"PHASE {phase_num}: MERGE & FINALIZE", Icons.SUCCESS)
        result = await self.phase_merge()
        results.append(result)

        # Summary
        ideation_file = self.output_dir / "ideation.json"
        if ideation_file.exists():
            with open(ideation_file) as f:
                ideation = json.load(f)

            ideas = ideation.get("ideas", [])
            summary = ideation.get("summary", {})
            by_type = summary.get("by_type", {})

            print(box(
                f"Total Ideas: {len(ideas)}\n\n"
                f"By Type:\n" +
                "\n".join(f"  {icon(Icons.ARROW_RIGHT)} {IDEATION_TYPE_LABELS.get(t, t)}: {c}"
                         for t, c in by_type.items()) +
                f"\n\nIdeation saved to: {ideation_file}",
                title=f"{icon(Icons.SUCCESS)} IDEATION COMPLETE",
                style="heavy"
            ))

        return True


def main():
    """CLI entry point."""
    import argparse

    parser = argparse.ArgumentParser(
        description="AI-powered ideation generation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--project",
        type=Path,
        default=Path.cwd(),
        help="Project directory (default: current directory)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output directory for ideation files (default: project/auto-claude/ideation)",
    )
    parser.add_argument(
        "--types",
        type=str,
        help=f"Comma-separated ideation types to run (options: {','.join(IDEATION_TYPES)})",
    )
    parser.add_argument(
        "--no-roadmap",
        action="store_true",
        help="Don't include roadmap context",
    )
    parser.add_argument(
        "--no-kanban",
        action="store_true",
        help="Don't include kanban context",
    )
    parser.add_argument(
        "--max-ideas",
        type=int,
        default=5,
        help="Maximum ideas per type (default: 5)",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="claude-sonnet-4-20250514",
        help="Model to use (default: claude-sonnet-4-20250514)",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Force regeneration even if ideation exists",
    )

    args = parser.parse_args()

    # Validate project directory
    project_dir = args.project.resolve()
    if not project_dir.exists():
        print(f"Error: Project directory does not exist: {project_dir}")
        sys.exit(1)

    # Parse types
    enabled_types = None
    if args.types:
        enabled_types = [t.strip() for t in args.types.split(",")]
        invalid_types = [t for t in enabled_types if t not in IDEATION_TYPES]
        if invalid_types:
            print(f"Error: Invalid ideation types: {invalid_types}")
            print(f"Valid types: {IDEATION_TYPES}")
            sys.exit(1)

    orchestrator = IdeationOrchestrator(
        project_dir=project_dir,
        output_dir=args.output,
        enabled_types=enabled_types,
        include_roadmap_context=not args.no_roadmap,
        include_kanban_context=not args.no_kanban,
        max_ideas_per_type=args.max_ideas,
        model=args.model,
        refresh=args.refresh,
    )

    try:
        success = asyncio.run(orchestrator.run())
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n\nIdeation generation interrupted.")
        sys.exit(1)


if __name__ == "__main__":
    main()
