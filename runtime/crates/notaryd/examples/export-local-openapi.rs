fn main() -> anyhow::Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(&notaryd::admin::openapi_document())?
    );
    Ok(())
}
