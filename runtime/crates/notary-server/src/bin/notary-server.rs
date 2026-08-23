#[tokio::main]
async fn main() -> anyhow::Result<()> {
    notary_server::run().await
}
