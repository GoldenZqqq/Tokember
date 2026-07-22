import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sub2api_collector import (
    Config,
    device_id,
    device_name,
    heartbeat_device,
    load_config,
    load_last_id,
    row_to_record,
    save_last_id,
    sync_rows,
)


def config() -> Config:
    return Config(
        server_url="https://tokember.example",
        api_key="test-key",
        state_path=Path("state.json"),
        docker_bin="docker",
        postgres_container="postgres",
        postgres_user="sub2api",
        postgres_db="sub2api",
        batch_size=500,
        start_id=697,
    )


def usage_row(**overrides: str) -> dict[str, str]:
    row = {
        "id": "698",
        "api_key_id": "4",
        "api_key_name": "hermes-27",
        "model": "grok-4.5",
        "input_tokens": "12",
        "output_tokens": "2",
        "cache_read_tokens": "0",
        "cache_creation_tokens": "0",
        "actual_cost": "0.0000360000",
        "created_at": "2026-07-14 13:39:34.063556+08",
        "ip_address": "203.0.113.27",
    }
    row.update(overrides)
    return row


class Sub2ApiCollectorTest(unittest.TestCase):
    @patch.dict(
        "os.environ",
        {
            "TOKEMBER_SERVER": "https://tokember.example",
            "AI_BURN_SERVER": "https://legacy.example",
            "TOKEMBER_API_KEY": "tokember-key",
            "AI_BURN_API_KEY": "legacy-key",
        },
        clear=True,
    )
    def test_prefers_tokember_environment(self) -> None:
        loaded = load_config()
        self.assertEqual("https://tokember.example", loaded.server_url)
        self.assertEqual("tokember-key", loaded.api_key)

    def test_maps_authoritative_usage(self) -> None:
        record = row_to_record(usage_row(actual_cost="0"))
        self.assertEqual("sub2api", record["provider"])
        self.assertEqual("sub2api:usage:698", record["dedup_key"])
        self.assertEqual("sub2api:key:4", record["source_file"])
        self.assertEqual("2026-07-14T05:39:34.063556Z", record["timestamp"])
        self.assertEqual(0, record["cost_usd"])
        self.assertTrue(record["cost_provided"])
        self.assertEqual(1, record["request_count"])
        self.assertFalse(record["input_includes_cache_read"])
        self.assertFalse(record["input_includes_cache_creation"])
        self.assertFalse(record["output_includes_reasoning"])

    def test_state_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            self.assertEqual(697, load_last_id(path, config().start_id))
            save_last_id(path, 698)
            self.assertEqual(698, load_last_id(path, config().start_id))
            self.assertEqual(1, json.loads(path.read_text(encoding="utf-8"))["version"])

    @patch("sub2api_collector.post_json")
    def test_registers_single_gateway_device(self, post_json) -> None:
        post_json.side_effect = [
            {"ok": True},
            {
                "ok": True, "created": 1, "updated": 0, "unchanged": 1,
                "total": 2, "inserted": 1,
            },
        ]
        rows = [
            usage_row(id="698", api_key_id="4", api_key_name="hermes-27"),
            usage_row(id="700", api_key_id="3", api_key_name="image"),
        ]
        self.assertEqual(1, sync_rows(config(), rows))
        self.assertEqual(
            {"id": "sub2api", "name": "sub2api"},
            post_json.call_args_list[0].args[2],
        )
        ingest_payload = post_json.call_args_list[1].args[2]
        self.assertEqual("sub2api", ingest_payload["device_id"])
        self.assertEqual(2, len(ingest_payload["records"]))
        self.assertEqual("sub2api", device_id())
        self.assertEqual("sub2api", device_name())
        self.assertEqual("test-key", post_json.call_args_list[0].args[3])

    @patch("sub2api_collector.post_json")
    def test_empty_run_heartbeats_single_device(self, post_json) -> None:
        post_json.return_value = {"ok": True}
        heartbeat_device(config())
        self.assertEqual(
            (
                "https://tokember.example",
                "/api/devices",
                {"id": "sub2api", "name": "sub2api"},
                "test-key",
            ),
            post_json.call_args.args,
        )


if __name__ == "__main__":
    unittest.main()

