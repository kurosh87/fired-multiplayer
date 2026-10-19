/* Independent test harness using the pinned mGBA public C API. This file and
 * the emulator library are never linked into or served by the browser game. */
#include <mgba/core/core.h>
#include <mgba/core/blip_buf.h>
#include <mgba-util/vfs.h>

static color_t sPixels[240 * 160];
static unsigned char sErasedSave[128 * 1024];

int main(int argc, char **argv)
{
    /* ROM, input text, output folder, gMain, save ptr, party, count, status, recap, save2 ptr,
     * optional flash and optional --storage-address pointer. Files are read into
     * a temporary in-memory cartridge. Keep existing invocation forms valid. */
    uint32_t storage_address = 0;
    if (argc >= 3 && strcmp(argv[argc - 2], "--storage-address") == 0)
    {
        storage_address = (uint32_t)strtoul(argv[argc - 1], NULL, 0);
        argc -= 2;
    }
    if (argc != 11 && argc != 12) return 2;
    struct mCore *core = mCoreFind(argv[1]);
    if (!core || !core->init(core)) return 3;
    mCoreInitConfig(core, "kanto-independent-reference");
    mCoreConfigSetDefaultIntValue(&core->config, "useBios", 0);
    mCoreConfigSetDefaultIntValue(&core->config, "skipBios", 1);
    mCoreLoadForeignConfig(core, &core->config); /* Never load user config. */
    core->setVideoBuffer(core, sPixels, 240);
    if (!mCoreLoadFile(core, argv[1])) return 4;
    memset(sErasedSave, 0xff, sizeof(sErasedSave));
    if (argc == 12)
    {
        FILE *save = fopen(argv[11], "rb");
        if (!save) return 12;
        if (fread(sErasedSave, 1, sizeof(sErasedSave), save) != sizeof(sErasedSave) || fgetc(save) != EOF) return 13;
        fclose(save);
    }
    if (!core->loadTemporarySave(core, VFileMemChunk(sErasedSave, sizeof(sErasedSave)))) return 5;
    core->reset(core);
    for (int channel = 0; channel < 2; channel++)
        blip_set_rates(core->getAudioChannel(core, channel), 16777216, 32768);
    FILE *inputs = fopen(argv[2], "r");
    if (!inputs) return 6;
    uint32_t main_address = (uint32_t)strtoul(argv[4], NULL, 0);
    uint32_t save_address = (uint32_t)strtoul(argv[5], NULL, 0);
    uint32_t party_address = (uint32_t)strtoul(argv[6], NULL, 0);
    uint32_t count_address = (uint32_t)strtoul(argv[7], NULL, 0);
    uint32_t status_address = (uint32_t)strtoul(argv[8], NULL, 0);
    uint32_t recap_address = (uint32_t)strtoul(argv[9], NULL, 0);
    /* The WASM boot call completes AgbMain initialization before frame zero.
     * Align the original to that observable boundary, without editing RAM or
     * choosing a game-specific frame delay. Its initialization resets the
     * counter and installs callback2 before the first copyright update. */
    unsigned startup = 0;
    while (startup < 300)
    {
        core->runFrame(core);
        for (int channel = 0; channel < 2; channel++) blip_clear(core->getAudioChannel(core, channel));
        startup++;
        if (core->busRead32(core, main_address + 4)
            && !core->busRead8(core, main_address + 0x438)
            && !core->busRead32(core, main_address + 0x24)) break;
    }
    if (startup == 300) return 11;
    printf("{\"startupHardwareFrames\":%u,\"alignment\":\"initialized-main-before-first-callback\"}\n", startup);
    unsigned buttons, count, capture, frame = 0;
    while (fscanf(inputs, "%u %u %u", &buttons, &count, &capture) == 3)
    {
        if (buttons > 1023 || count < 1 || count > 60) return 7;
        core->setKeys(core, buttons);
        for (unsigned i = 0; i < count; i++)
        {
            core->runFrame(core);
            for (int channel = 0; channel < 2; channel++) blip_clear(core->getAudioChannel(core, channel));
            frame++;
        }
        if (capture)
        {
            char path[4096];
            if (snprintf(path, sizeof(path), "%s/frame-%u.rgba", argv[3], frame) >= sizeof(path)) return 8;
            FILE *image = fopen(path, "wb");
            if (!image) return 9;
            for (unsigned pixel = 0; pixel < 240 * 160; pixel++)
            {
                /* mGBA's default native colors are little-endian RGBX. */
                uint32_t value = sPixels[pixel] | 0xff000000;
                unsigned char rgba[4] = {value, value >> 8, value >> 16, value >> 24};
                if (fwrite(rgba, 1, 4, image) != 4) return 10;
            }
            fclose(image);
            uint32_t save = core->busRead32(core, save_address);
            printf("{\"frame\":%u,\"callbackAddress\":%u,\"mainState\":%u,\"vblankCount\":%u,\"mapGroup\":%u,\"mapNumber\":%u,\"saveStatus\":%u,\"partyCount\":%u,\"level\":%u,\"hp\":%u,\"isBadEgg\":%u,\"questLog\":%u}\n",
                   frame, core->busRead32(core, main_address + 4), core->busRead8(core, main_address + 0x438),
                   core->busRead32(core, main_address + 0x24),
                   core->busRead8(core, save + 4), core->busRead8(core, save + 5),
                   core->busRead16(core, status_address), core->busRead8(core, count_address),
                   core->busRead8(core, party_address + 84), core->busRead16(core, party_address + 86),
                   core->busRead8(core, party_address + 19) & 1, core->busRead8(core, recap_address));
            fflush(stdout);
        }
    }
    fclose(inputs);
    /* Read back all original party bytes after the menu has exercised its
     * checksum/decryption paths. The harness never edits emulated RAM. */
    char party_path[4096];
    if (snprintf(party_path, sizeof(party_path), "%s/party.bin", argv[3]) >= sizeof(party_path)) return 14;
    FILE *party = fopen(party_path, "wb");
    if (!party) return 15;
    for (unsigned i = 0; i < 6 * 100; i++)
        if (fputc(core->busRead8(core, party_address + i), party) == EOF) return 16;
    if (fclose(party)) return 17;
    if (snprintf(party_path, sizeof(party_path), "%s/saveblock1.bin", argv[3]) >= sizeof(party_path)) return 18;
    FILE *block = fopen(party_path, "wb");
    if (!block) return 19;
    uint32_t save = core->busRead32(core, save_address);
    for (unsigned i = 0; i < 0x3d68; i++)
        if (fputc(core->busRead8(core, save + i), block) == EOF) return 20;
    if (fclose(block)) return 21;
    if (snprintf(party_path, sizeof(party_path), "%s/saveblock2.bin", argv[3]) >= sizeof(party_path)) return 22;
    block = fopen(party_path, "wb");
    if (!block) return 23;
    save = core->busRead32(core, (uint32_t)strtoul(argv[10], NULL, 0));
    for (unsigned i = 0; i < 0xf24; i++)
        if (fputc(core->busRead8(core, save + i), block) == EOF) return 24;
    if (fclose(block)) return 25;
    if (storage_address)
    {
        if (snprintf(party_path, sizeof(party_path), "%s/storage.bin", argv[3]) >= sizeof(party_path)) return 26;
        block = fopen(party_path, "wb");
        if (!block) return 27;
        uint32_t storage = core->busRead32(core, storage_address);
        if (storage < 0x02000000 || storage + 0x83d0 > 0x02040000) return 28;
        for (unsigned i = 0; i < 0x83d0; i++)
            if (fputc(core->busRead8(core, storage + i), block) == EOF) return 29;
        if (fclose(block)) return 30;
    }
    core->unloadROM(core);
    mCoreConfigDeinit(&core->config);
    core->deinit(core);
    return 0;
}
