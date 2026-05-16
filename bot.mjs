import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, GuildMember, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import http from "http";

const ROBLOX_GROUP_ID = 973049555;
const VERIFY_TIMEOUT_MS = 2 * 60 * 1000;
const SCAN_INTERVAL_MS = 2000;
const PORT = process.env.PORT || 8080;

const pending = new Map();

function generateCode(length = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let result = "";
  for (let i = 0; i < length; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

async function getRobloxUserId(username) {
  try {
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });
    const data = await res.json();
    if (data.data && data.data.length > 0) return data.data[0].id;
    return null;
  } catch { return null; }
}

async function getRobloxDescription(userId) {
  try {
    const res = await fetch(`https://users.roblox.com/v1/users/${userId}`);
    const data = await res.json();
    return data.description ?? null;
  } catch { return null; }
}

async function getRobloxGroupRank(userId, groupId) {
  try {
    const res = await fetch(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
    const data = await res.json();
    if (!data.data) return null;
    const entry = data.data.find(g => g.group.id === groupId);
    return entry ? entry.role.name : null;
  } catch { return null; }
}

function cancelVerification(userId) {
  const v = pending.get(userId);
  if (v) { clearInterval(v.interval); clearTimeout(v.timeout); pending.delete(userId); }
}

async function syncRobloxRole(member, rankName) {
  const guild = member.guild;
  let role = guild.roles.cache.find(r => r.name.toLowerCase() === rankName.toLowerCase());
  if (!role) {
    try { role = await guild.roles.create({ name: rankName, reason: "Roblox group rank sync" }); }
    catch (err) { console.error("Failed to create role:", err.message); return; }
  }
  try { await member.roles.add(role, "Roblox verification rank sync"); }
  catch (err) { console.error("Failed to assign role:", err.message); }
}

async function giveVerifiedRole(member) {
  const guild = member.guild;
  let role = guild.roles.cache.find(r => r.name.toLowerCase() === "verified");
  if (!role) {
    try { role = await guild.roles.create({ name: "Verified", color: 0x57f287, reason: "Created by verification bot" }); }
    catch (err) { console.error("Failed to create Verified role:", err.message); return; }
  }
  try { await member.roles.add(role, "User completed Roblox verification"); }
  catch (err) { console.error("Failed to assign Verified role:", err.message); }
}

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) { console.error("DISCORD_BOT_TOKEN not set"); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const commands = [new SlashCommandBuilder().setName("verify").setDescription("Verify your Roblox account").toJSON()];
  const rest = new REST({ version: "10" }).setToken(token);
  try { await rest.put(Routes.applicationCommands(client.user.id), { body: commands }); console.log("Slash commands registered"); }
  catch (err) { console.error("Failed to register commands:", err.message); }
});

client.on("interactionCreate", async interaction => {
  if (interaction.isChatInputCommand() && interaction.commandName === "verify") {
    if (pending.has(interaction.user.id)) {
      await interaction.reply({ content: "You already have a verification in progress. Check your DMs!", ephemeral: true });
      return;
    }
    const modal = new ModalBuilder().setCustomId("verify_modal").setTitle("Roblox Verification");
    const usernameInput = new TextInputBuilder().setCustomId("roblox_username").setLabel("What is your Roblox username?").setStyle(TextInputStyle.Short).setPlaceholder("e.g. Builderman").setRequired(true).setMaxLength(20);
    modal.addComponents(new ActionRowBuilder().addComponents(usernameInput));
    await interaction.showModal(modal);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === "verify_modal") {
    if (pending.has(interaction.user.id)) {
      await interaction.reply({ content: "You already have a verification in progress. Check your DMs!", ephemeral: true });
      return;
    }
    const robloxUsername = interaction.fields.getTextInputValue("roblox_username").trim();
    const robloxId = await getRobloxUserId(robloxUsername);
    if (!robloxId) {
      await interaction.reply({ content: `Could not find a Roblox user named **${robloxUsername}**. Check the spelling and try again.`, ephemeral: true });
      return;
    }
    const code = generateCode();
    const cancelButton = new ButtonBuilder().setCustomId(`cancel_verify_${interaction.user.id}`).setLabel("Cancel Verification").setStyle(ButtonStyle.Danger);
    const row = new ActionRowBuilder().addComponents(cancelButton);
    const embed = new EmbedBuilder().setTitle("Roblox Verification").setColor(0x5865f2)
      .setDescription(`To verify ownership of **${robloxUsername}**, please:\n\n1. Go to your Roblox profile: https://www.roblox.com/users/${robloxId}/profile\n2. Edit your **About/Description** and paste the code from the message below\n3. Save your profile — we'll detect it automatically\n\nYou have **2 minutes**. You can remove the code after verification.`)
      .setFooter({ text: "Scanning every 2 seconds..." });
    let dmChannel, instructionMsg;
    try {
      dmChannel = await interaction.user.createDM();
      instructionMsg = await dmChannel.send({ embeds: [embed], components: [row] });
      await dmChannel.send(`**Copy your code:** \`${code}\``);
    } catch {
      await interaction.reply({ content: "I couldn't DM you. Please enable DMs from server members and try again.", ephemeral: true });
      return;
    }
    await interaction.reply({ content: "Check your DMs for verification instructions!", ephemeral: true });

    const scanInterval = setInterval(async () => {
      const description = await getRobloxDescription(robloxId);
      if (description && description.includes(code)) {
        cancelVerification(interaction.user.id);
        let rankName = null;
        const member = interaction.guild?.members.cache.get(interaction.user.id) ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
        if (member) {
          await giveVerifiedRole(member);
          rankName = await getRobloxGroupRank(robloxId, ROBLOX_GROUP_ID);
          if (rankName) await syncRobloxRole(member, rankName);
        }
        try { await instructionMsg.edit({ components: [] }); } catch {}
        try {
          await dmChannel.send({ embeds: [new EmbedBuilder().setTitle("✅ You're verified!").setColor(0x57f287)
            .setDescription(`Your Roblox account **${robloxUsername}** has been linked to your Discord.\n\n${rankName ? `🎖️ Your group rank **${rankName}** has been synced as a Discord role.` : "You're not in the Roblox group, so no rank role was assigned."}\n\nYou can remove the code from your Roblox description now.`)
            .setTimestamp()] });
        } catch {}
      }
    }, SCAN_INTERVAL_MS);

    const verifyTimeout = setTimeout(async () => {
      cancelVerification(interaction.user.id);
      try { await instructionMsg.edit({ components: [] }); } catch {}
      try { await dmChannel.send({ embeds: [new EmbedBuilder().setTitle("⏰ Verification timed out").setColor(0xed4245).setDescription("We couldn't detect your code in time. Run `/verify` again whenever you're ready.")] }); } catch {}
    }, VERIFY_TIMEOUT_MS);

    pending.set(interaction.user.id, { discordUserId: interaction.user.id, robloxUsername, code, interval: scanInterval, timeout: verifyTimeout });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("cancel_verify_")) {
    const userId = interaction.customId.replace("cancel_verify_", "");
    if (userId === interaction.user.id) {
      cancelVerification(userId);
      await interaction.update({ content: "Verification cancelled.", components: [] });
    }
  }
});

client.login(token).catch(err => { console.error("Failed to log in:", err.message); process.exit(1); });

// Health check server to keep Render alive
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
}).listen(PORT, () => console.log(`Health server on port ${PORT}`));
