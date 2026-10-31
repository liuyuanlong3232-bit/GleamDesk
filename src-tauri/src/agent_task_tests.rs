use super::*;
use crate::agent_room::workspace::{AgentApiMessage, AgentApiToolCall, AgentApiTurn};

fn tool(name: &str) -> AgentApiToolCall {
    let arguments = match name {
        "read_text" => serde_json::json!({"path":"README.md"}),
        "list_files" => serde_json::json!({}),
        "search_text" => serde_json::json!({"query":"needle"}),
        "propose_edit" => serde_json::json!({"path":"README.md","old_text":"old","new_text":"new"}),
        _ => serde_json::json!({"command":"cargo test"}),
    };
    AgentApiToolCall { id: "tool-1".into(), name: name.into(), arguments }
}

#[test]
fn unknown_api_tool_fails_before_any_local_handler_runs() {
    let mut executed = 0;
    let result = run_agent_loop("check", |_| Ok(AgentApiTurn::ToolCalls {
        text: String::new(), calls: vec![tool("unknown")], provider_payload: serde_json::json!({"raw":true}),
    }), |_| { executed += 1; Ok("should not run".into()) });
    assert!(result.is_err());
    assert_eq!(executed, 0);
}

#[test]
fn provider_failure_is_returned_without_retry() {
    let mut requests = 0;
    let result = run_agent_loop("check", |_| { requests += 1; Err("API rejected request".into()) }, |_| Ok(String::new()));
    assert!(result.unwrap_err().contains("rejected"));
    assert_eq!(requests, 1);
}

#[test]
fn command_result_is_returned_to_model_before_final_answer() {
    let mut requests = 0;
    let answer = run_agent_loop("run tests", |history| {
        requests += 1;
        if requests == 1 {
            Ok(AgentApiTurn::ToolCalls { text: String::new(), calls: vec![tool("run_command")], provider_payload: serde_json::json!({"raw":"assistant"}) })
        } else {
            assert!(history.iter().any(|item| matches!(item, AgentApiMessage::ToolResults(results) if results.iter().any(|result| result.content.contains("exit code 1")))));
            Ok(AgentApiTurn::Text("Fix is ready".into()))
        }
    }, |_| Ok("exit code 1\nfailed test".into())).unwrap();
    assert_eq!(answer, "Fix is ready");
    assert_eq!(requests, 2);
}

#[test]
fn task_stops_after_ten_model_round_trips() {
    let mut requests = 0;
    let result = run_agent_loop("keep working", |_| {
        requests += 1;
        Ok(AgentApiTurn::ToolCalls { text: String::new(), calls: vec![tool("read_text")], provider_payload: serde_json::json!({"turn":requests}) })
    }, |_| Ok("read".into()));
    assert!(result.unwrap_err().contains("10"));
    assert_eq!(requests, 10);
}

#[test]
fn approval_gate_rejects_wrong_id_and_wait_observes_cancel() {
    let gate = ApprovalGate::default();
    gate.begin("approval-1").unwrap();
    assert!(gate.resolve("approval-other", true).is_err());
    assert!(gate.resolve("approval-1", false).unwrap());
    assert_eq!(gate.wait("approval-1", &AtomicBool::new(false)).unwrap(), Some(false));
    gate.begin("approval-2").unwrap();
    assert_eq!(gate.wait("approval-2", &AtomicBool::new(true)).unwrap(), None);
}

#[test]
fn command_output_limit_is_bounded() {
    let limited = bounded_output(&"x".repeat(MAX_COMMAND_OUTPUT_CHARS + 100));
    assert_eq!(limited.text.chars().count(), MAX_COMMAND_OUTPUT_CHARS);
    assert!(limited.truncated);
}

#[allow(dead_code)]
fn _compile_time_call_shape(call: AgentApiToolCall) { let _ = call; }
