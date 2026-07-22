import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("hermes_collector.py")
SPEC = importlib.util.spec_from_file_location("hermes_collector", MODULE_PATH)
collector = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(collector)


class HermesCollectorTest(unittest.TestCase):
    def test_prefers_tokember_environment_and_legacy_state(self):
        with patch.dict(
            collector.os.environ,
            {"TOKEMBER_SERVER": "https://tokember.example", "AI_BURN_SERVER": "https://legacy.example"},
            clear=True,
        ):
            self.assertEqual(
                "https://tokember.example",
                collector.env_value("TOKEMBER_SERVER", "AI_BURN_SERVER"),
            )

        with tempfile.TemporaryDirectory() as directory:
            canonical = Path(directory) / "tokember.json"
            legacy = Path(directory) / "ai-burn.json"
            legacy.write_text("{}", encoding="utf-8")
            self.assertEqual(legacy, collector.preferred_state_path(canonical, legacy))

    def test_device_token_precedes_shared_key(self):
        with patch.dict(
            collector.os.environ,
            {"TOKEMBER_DEVICE_TOKEN": "device-token", "TOKEMBER_API_KEY": "shared-key"},
            clear=True,
        ):
            self.assertEqual("device-token", collector.configured_auth_token())

    def test_register_device_sends_machine_metadata(self):
        with patch.object(collector, "post_json") as post_json, patch.object(
            collector.runtime_platform, "system", return_value="Linux"
        ), patch.object(
            collector.runtime_platform, "machine", return_value="x86_64"
        ), patch.object(
            collector.socket, "gethostname", return_value="huawei-27-host"
        ), patch.object(collector, "DEVICE_ID", "huawei-27"), patch.object(
            collector, "DEVICE_NAME", "HUAWEI-27"
        ):
            collector.register_device()

        post_json.assert_called_once_with("/api/devices", {
            "id": "huawei-27", "name": "HUAWEI-27", "platform": "linux",
            "architecture": "x86_64", "hostname": "huawei-27-host",
        })

    def test_collects_snapshots_and_prefers_actual_cost(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "state.db"
            self.create_database(db_path)
            snapshots = collector.collect_snapshots(str(db_path))

        self.assertEqual(1, len(snapshots))
        record = snapshots["session-1"]
        self.assertEqual(0.75, record["cost_usd"])

    def test_builds_only_incremental_usage(self):
        previous = self.snapshot(input_tokens=100, output_tokens=20, api_call_count=2)
        current = self.snapshot(input_tokens=160, output_tokens=35, api_call_count=3)
        records = collector.build_delta_records({"session-1": current}, {"session-1": previous})

        self.assertEqual(1, len(records))
        record = records[0]
        self.assertEqual("hermes", record["provider"])
        self.assertEqual("mimo-v2.5-pro", record["model"])
        self.assertEqual(60, record["input_tokens"])
        self.assertEqual(15, record["output_tokens"])
        self.assertEqual(1, record["request_count"])
        self.assertFalse(record["input_includes_cache_read"])
        self.assertFalse(record["input_includes_cache_creation"])
        self.assertFalse(record["output_includes_reasoning"])
        self.assertIn("hermes-delta", record["dedup_key"])
        self.assertEqual("disabled", record["attribution_status"])
        self.assertNotIn("session_id", record)

    def test_enabled_attribution_hashes_session_without_persisting_raw_seed(self):
        current = self.snapshot(input_tokens=100)
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            collector.os.environ,
            {
                "TOKEMBER_ATTRIBUTION_ENABLED": "true",
            },
            clear=False,
        ), patch.object(
            collector, "ATTRIBUTION_SECRET_PATH", Path(directory) / "secret"
        ):
            record = collector.build_delta_record(
                current, self.snapshot(input_tokens=0),
                (True, collector.load_or_create_secret(Path(directory) / "secret")),
            )
        self.assertIsNotNone(record)
        self.assertRegex(record["session_id"], r"^ses_v1_[A-Za-z0-9_-]{43}$")
        self.assertNotEqual(current["id"], record["session_id"])

    def test_preserves_multi_call_and_call_only_deltas(self):
        previous = self.snapshot(api_call_count=2)
        current = self.snapshot(api_call_count=5)

        records = collector.build_delta_records(
            {"session-1": current}, {"session-1": previous}
        )

        self.assertEqual(1, len(records))
        self.assertEqual(3, records[0]["request_count"])
        self.assertEqual(0, records[0]["input_tokens"])

    def test_bootstrap_emits_only_sessions_active_inside_window(self):
        current = {
            "recent": self.snapshot(id="recent", activity_at=900, input_tokens=100),
            "old": self.snapshot(id="old", activity_at=500, input_tokens=200),
        }

        records = collector.build_bootstrap_records(
            current,
            now_epoch=1000,
            bootstrap_hours=0.1,
        )

        self.assertEqual(1, len(records))
        self.assertIn(":recent:", records[0]["dedup_key"])
        self.assertEqual(100, records[0]["input_tokens"])

    def test_rejects_invalid_bootstrap_window(self):
        with patch.dict(
            collector.os.environ,
            {"TOKEMBER_HERMES_BOOTSTRAP_HOURS": "invalid"},
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "must be a positive number"):
                collector.build_bootstrap_records({})

    def test_schedule_metadata_is_explicit_without_changing_timer(self):
        with patch.dict(
            collector.os.environ,
            {"TOKEMBER_SCHEDULE_INTERVAL_MINUTES": "60"},
            clear=True,
        ):
            self.assertEqual(60, collector.new_run_start()["schedule_interval_minutes"])
        with patch.dict(
            collector.os.environ,
            {"TOKEMBER_SCHEDULE_INTERVAL_MINUTES": "0"},
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "integer between"):
                collector.new_run_start()
        setup = MODULE_PATH.with_name("setup-hermes-collector.sh").read_text(encoding="utf-8")
        self.assertIn("TOKEMBER_SCHEDULE_INTERVAL_MINUTES=60", setup)
        self.assertIn("OnUnitActiveSec=1h", setup)

    def test_canonical_bootstrap_window_precedes_legacy_alias(self):
        current = {
            "session-1": self.snapshot(activity_at=900, input_tokens=100),
        }
        with patch.dict(
            collector.os.environ,
            {
                "TOKEMBER_HERMES_BOOTSTRAP_HOURS": "0.01",
                "AI_BURN_HERMES_BOOTSTRAP_HOURS": "1",
            },
            clear=True,
        ):
            records = collector.build_bootstrap_records(current, now_epoch=1000)

        self.assertEqual([], records)

        with patch.dict(
            collector.os.environ,
            {"AI_BURN_HERMES_BOOTSTRAP_HOURS": "1"},
            clear=True,
        ):
            records = collector.build_bootstrap_records(current, now_epoch=1000)

        self.assertEqual(1, len(records))

    def test_first_run_ingests_bootstrap_before_saving_state(self):
        snapshots = {"session-1": self.snapshot(activity_at=900, input_tokens=100)}
        events = []

        with (
            patch.object(collector, "collect_snapshots", return_value=snapshots),
            patch.object(collector, "register_device"),
            patch.object(collector, "load_state", return_value=None),
            patch.object(collector, "build_bootstrap_records", return_value=[{"record": 1}]),
            patch.object(collector, "ingest", side_effect=lambda records: events.append("ingest") or 1),
            patch.object(collector, "save_state", side_effect=lambda records: events.append("save")),
        ):
            self.assertEqual(0, collector.main())

        self.assertEqual(["ingest", "save"], events)

    def test_first_run_does_not_save_state_when_bootstrap_fails(self):
        snapshots = {"session-1": self.snapshot(activity_at=900, input_tokens=100)}
        with (
            patch.object(collector, "collect_snapshots", return_value=snapshots),
            patch.object(collector, "register_device"),
            patch.object(collector, "load_state", return_value=None),
            patch.object(collector, "build_bootstrap_records", return_value=[{"record": 1}]),
            patch.object(collector, "ingest", side_effect=RuntimeError("network failed")),
            patch.object(collector, "save_state") as save_state,
        ):
            with self.assertRaisesRegex(RuntimeError, "network failed"):
                collector.main()

        save_state.assert_not_called()

    def test_first_run_does_not_save_state_when_registration_fails(self):
        snapshots = {"session-1": self.snapshot(activity_at=900, input_tokens=100)}
        with (
            patch.object(collector, "collect_snapshots", return_value=snapshots),
            patch.object(collector, "register_device", side_effect=RuntimeError("register failed")),
            patch.object(collector, "save_state") as save_state,
        ):
            with self.assertRaisesRegex(RuntimeError, "register failed"):
                collector.main()

        save_state.assert_not_called()

    def test_ingest_prefers_exact_counts_and_accepts_legacy_response(self):
        exact = {
            "ok": True, "created": 1, "updated": 2, "unchanged": 1,
            "total": 4, "inserted": 3,
        }
        with patch.object(collector, "post_json", return_value=exact):
            self.assertEqual(3, collector.ingest([{"record": index} for index in range(4)]))
        with patch.object(collector, "post_json", return_value={"inserted": 2}):
            self.assertEqual(2, collector.ingest([{"record": 1}, {"record": 2}]))

    def test_second_chunk_timeout_does_not_save_state(self):
        snapshots = {"session-1": self.snapshot(activity_at=900, input_tokens=100)}
        records = [{"record": index} for index in range(501)]
        first_ack = {
            "ok": True, "created": 500, "updated": 0, "unchanged": 0,
            "total": 500, "inserted": 500,
        }
        with (
            patch.object(collector, "collect_snapshots", return_value=snapshots),
            patch.object(collector, "register_device"),
            patch.object(collector, "load_state", return_value=None),
            patch.object(collector, "build_bootstrap_records", return_value=records),
            patch.object(collector, "post_json", side_effect=[first_ack, TimeoutError("timed out")]),
            patch.object(collector, "save_state") as save_state,
        ):
            with self.assertRaisesRegex(TimeoutError, "timed out"):
                collector.main()

        save_state.assert_not_called()

    def test_malformed_acknowledgement_does_not_save_state(self):
        snapshots = {"session-1": self.snapshot(activity_at=900, input_tokens=100)}
        with (
            patch.object(collector, "collect_snapshots", return_value=snapshots),
            patch.object(collector, "register_device"),
            patch.object(collector, "load_state", return_value=None),
            patch.object(collector, "build_bootstrap_records", return_value=[{"record": 1}]),
            patch.object(collector, "post_json", return_value={"ok": True}),
            patch.object(collector, "save_state") as save_state,
        ):
            with self.assertRaisesRegex(ValueError, "acknowledgement"):
                collector.main()

        save_state.assert_not_called()

    def test_telemetry_failure_does_not_change_successful_session_state(self):
        snapshots = {"session-1": self.snapshot(activity_at=900, input_tokens=100)}
        with tempfile.TemporaryDirectory() as directory:
            outbox = Path(directory) / "observability.json"
            events = []
            with (
                patch.object(collector, "collect_snapshots", return_value=snapshots),
                patch.object(collector, "register_device"),
                patch.object(collector, "load_state", return_value={}),
                patch.object(collector, "build_delta_records", return_value=[{"timestamp": "2026-07-17T00:00:00.000Z"}]),
                patch.object(collector, "ingest", return_value=1),
                patch.object(collector, "save_state", side_effect=lambda state: events.append("save")),
                patch.object(collector, "report_run", side_effect=RuntimeError("telemetry unavailable")),
            ):
                self.assertEqual(0, collector.main(report_telemetry=True, outbox=outbox))

            self.assertEqual(["save"], events)
            state = collector.load_outbox(outbox)
            self.assertEqual([], state["running"])
            self.assertEqual(1, len(state["reports"]))
            self.assertEqual("success", state["reports"][0]["status"])

    def test_successful_source_reports_real_collection_and_upload_duration(self):
        source = collector.successful_hermes_source(
            {}, [], accepted=0, unchanged=0, duration_ms=275
        )

        self.assertEqual(275, source["duration_ms"])

    def test_successful_run_appends_collector_runtime_success(self):
        start = collector.new_run_start(run_id="hermes-ok")
        hermes = collector.successful_hermes_source(
            {}, [], accepted=1, unchanged=0, duration_ms=40
        )
        report = collector.build_run_report(start, [hermes])
        self.assertEqual("success", report["status"])
        self.assertEqual(1, report["accepted"])
        self.assertEqual(
            [("hermes", "success"), ("collector", "success")],
            [(source["source"], source["status"]) for source in report["sources"]],
        )

    def test_failed_run_keeps_collector_failure_without_invented_success(self):
        start = collector.new_run_start(run_id="hermes-fail")
        report = collector.failed_run_report(start, "Server /api/devices request timed out")
        self.assertEqual("failed", report["status"])
        self.assertEqual(1, len(report["sources"]))
        self.assertEqual("collector", report["sources"][0]["source"])
        self.assertEqual("collection_failed", report["sources"][0]["status"])

    def test_outbox_recovers_abandoned_run_and_redacts_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "observability.json"
            first = collector.new_run_start(run_id="first")
            second = collector.new_run_start(run_id="second")
            collector.recover_and_begin_run(first, path)
            collector.recover_and_begin_run(second, path)
            state = collector.load_outbox(path)

            self.assertEqual("second", state["running"][0]["run_id"])
            self.assertEqual("failed", state["reports"][0]["status"])
            self.assertIn("terminated before completion", state["reports"][0]["error_summary"])

    def test_error_summary_redacts_secrets_and_user_paths(self):
        result = collector.sanitize_error(
            "Authorization: Bearer secret X-API-Key: second-secret API_KEY='quoted value' "
            "TOKEMBER_DEVICE_TOKEN=tkdc_abcdefghijkl_abcdefghijklmnopqrstuvwxyz123456 "
            "C:\\Users\\Alice\\private.json /home/bob/session.json " + "x" * 800
        )
        self.assertNotIn("secret", result)
        self.assertNotIn("quoted", result)
        self.assertNotIn("value", result)
        self.assertNotIn("Alice", result)
        self.assertNotIn("bob", result)
        self.assertNotIn("tkdc_", result)
        self.assertLessEqual(len(result), 500)

    @staticmethod
    def snapshot(**overrides):
        base = {
            "id": "session-1", "model": "mimo-v2.5-pro",
            "billing_provider": "xiaomi", "cost_status": "unknown",
            "activity_at": 200, "cost_usd": 0,
            "input_tokens": 0, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "reasoning_tokens": 0, "api_call_count": 0,
        }
        return {**base, **overrides}

    @staticmethod
    def create_database(path: Path):
        db = sqlite3.connect(path)
        try:
            db.execute(
                """
                CREATE TABLE sessions (
                  id TEXT, model TEXT, started_at REAL, ended_at REAL,
                  input_tokens INTEGER, output_tokens INTEGER,
                  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
                  reasoning_tokens INTEGER, billing_provider TEXT,
                  estimated_cost_usd REAL, actual_cost_usd REAL,
                  cost_status TEXT, api_call_count INTEGER
                )
                """
            )
            db.execute(
                """
                INSERT INTO sessions VALUES
                ('session-1', 'mimo-v2.5-pro', 100, 200,
                 120, 30, 40, 5, 7, 'xiaomi', 0.25, 0.75, 'actual', 3)
                """
            )
            db.execute("CREATE TABLE messages (session_id TEXT, timestamp REAL)")
            db.execute("INSERT INTO messages VALUES ('session-1', 250)")
            db.commit()
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
